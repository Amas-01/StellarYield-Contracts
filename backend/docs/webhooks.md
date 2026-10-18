# StellarYield Webhooks

This document describes the webhook system for receiving real-time notifications about vault and yield events.

## Webhook Event Types

The following events are supported:

- `deposit` - User deposits funds into a vault
- `withdraw` - User withdraws funds from a vault
- `yield_distributed` - Yield is distributed for an epoch
- `vault_state_changed` - Vault transitions between lifecycle states
- `vault.matured` - Vault reaches maturity date
- `vault_created` - New vault is deployed

## Webhook Payload Schema

All webhooks use a common envelope structure:

```json
{
  "event": "deposit",
  "contractId": "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K",
  "timestamp": 1719417600000,
  "payload": {
    "user": "GBXXL...",
    "amount": "1000000000",
    "shares": "1000000000"
  }
}
```

### Event Payloads

#### `deposit`
```json
{
  "event": "deposit",
  "contractId": "CBQHN...",
  "timestamp": 1719417600000,
  "payload": {
    "user": "GBXXL...",
    "amount": "1000000000",
    "shares": "1000000000"
  }
}
```

#### `withdraw`
```json
{
  "event": "withdraw",
  "contractId": "CBQHN...",
  "timestamp": 1719417600000,
  "payload": {
    "user": "GBXXL...",
    "amount": "500000000",
    "shares": "500000000"
  }
}
```

#### `yield_distributed`
```json
{
  "event": "yield_distributed",
  "contractId": "CBQHN...",
  "timestamp": 1719417600000,
  "payload": {
    "epoch": 1,
    "total_yield": "50000000",
    "total_shares": "10000000000"
  }
}
```

#### `vault_state_changed`
```json
{
  "event": "vault_state_changed",
  "contractId": "CBQHN...",
  "timestamp": 1719417600000,
  "payload": {
    "new_state": "Active"
  }
}
```

#### `vault.matured`
```json
{
  "event": "vault.matured",
  "contractId": "CBQHN...",
  "timestamp": 1719417600000,
  "payload": {}
}
```

#### `vault_created`
```json
{
  "event": "vault_created",
  "contractId": "CBQHN...",
  "timestamp": 1719417600000,
  "payload": {
    "asset_address": "CDLZFC...",
    "admin": "GBXXL...",
    "expected_apy": 500,
    "maturity_date": 1735689600,
    "funding_deadline": 1720022400,
    "min_deposit": "100000000",
    "max_deposit": "10000000000"
  }
}
```

## Signature Verification

All webhook requests include an HMAC-SHA256 signature in the `X-StellarYield-Signature` header. Verify this signature to ensure the webhook is authentic.

### Verification Steps

1. Extract the signature from the `X-StellarYield-Signature` header
2. Compute HMAC-SHA256 of the raw request body using your webhook secret
3. Compare the computed signature with the received signature using constant-time comparison

### Node.js Example

```javascript
const crypto = require('crypto');

function verifyWebhook(payload, signature, secret) {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

app.post('/webhook', (req, res) => {
  const signature = req.headers['x-stellaryield-signature'];
  const payload = JSON.stringify(req.body);
  const secret = process.env.WEBHOOK_SECRET;
  
  if (!verifyWebhook(payload, signature, secret)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  console.log('Received event:', req.body.event);
  res.status(200).json({ received: true });
});
```

### Python Example

```python
import hmac
import hashlib

def verify_webhook(payload, signature, secret):
    expected_signature = hmac.new(
        secret.encode('utf-8'),
        payload.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()
    
    return hmac.compare_digest(signature, expected_signature)

@app.route('/webhook', methods=['POST'])
def webhook():
    signature = request.headers.get('X-StellarYield-Signature')
    payload = request.get_data(as_text=True)
    secret = os.environ.get('WEBHOOK_SECRET')
    
    if not verify_webhook(payload, signature, secret):
        return {'error': 'Invalid signature'}, 401
    
    event = request.json
    print(f"Received event: {event['event']}")
    return {'received': True}, 200
```

## Channel Priority Ordering

Each webhook has an integer `priority` (default `0`; **lower value = higher priority**).
When an event fires, `NotificationService` dispatches to every subscribed webhook, but
attempts them in ascending priority order. Webhooks that share a priority value are
dispatched concurrently; each priority tier is enqueued before the next tier starts.

Set the priority when registering a webhook:

```json
POST /api/v1/webhooks
{
  "url": "https://example.com/primary",
  "events": ["deposit"],
  "priority": -10
}
```

`GET /api/v1/webhooks` returns `priority` (and `fallbackChannel`) on every row, and lists
webhooks in priority order.

## Per-Event Throttling

A webhook may set `maxPerHour`, an integer cap on how many deliveries it receives within
a single clock hour (UTC). A high-volume vault can emit hundreds of events per hour;
without a cap the webhook endpoint is flooded.

```json
POST /api/v1/webhooks
{
  "url": "https://example.com/hook",
  "events": ["deposit"],
  "maxPerHour": 60
}
```

Omit `maxPerHour` (or send `null`) for no limit. The delivery count is tracked per
webhook per hour in Redis. Once it exceeds `maxPerHour`, further events in that hour are
skipped (a warning is logged; the skip is **not** counted as a delivery failure). The
counter resets automatically at the top of the next hour. If Redis is unavailable the
throttle fails open and all events are delivered.

## Circuit Breaker (#1061)

After **5 consecutive failed deliveries** the endpoint's circuit opens
(`webhooks.circuit_open = TRUE`). While the circuit is open the backend makes **no
further delivery attempts** for that endpoint — queued jobs are dropped without an HTTP
request and scheduled retries are skipped — so a dead endpoint stops consuming retry
budget and job-queue capacity.

Skipped deliveries are not counted as failures, and opening the circuit does **not**
deactivate the webhook. Reset it to resume deliveries on the next triggered event:

```bash
POST /api/v1/admin/webhooks/42/circuit-reset
→ 200 { "id": 42, "circuitOpen": false, "consecutiveFailures": 0 }
```

The reset also clears `consecutive_failures`, otherwise the next failure would
immediately re-trip the breaker. Requires an `admin` API key.

## Secret Rotation (#1062)

`POST /api/v1/admin/webhooks/:id/rotate-secret` issues a fresh HMAC secret. The previous
secret is retained for a transition window (`SECRET_ROTATION_WINDOW_HOURS`, default 24)
and then purged, so receivers can roll over without downtime.

```bash
POST /api/v1/admin/webhooks/42/rotate-secret
→ 200 {
    "id": 42,
    "secret": "<new secret — returned once, never readable again>",
    "rotationWindowHours": 24,
    "previousSecretRetained": true,
    "rotatesAt": "2026-09-30T05:00:00.000Z"
  }
```

During the window each delivery carries **two** signature headers:

| Header | Secret |
| --- | --- |
| `X-StellarYield-Signature` | current secret |
| `X-StellarYield-Signature-Previous` | previous secret (window only) |

After the window elapses only `X-StellarYield-Signature` is sent and the old secret is
deleted. Accept either header while the receiver migrates, then drop the fallback.

## Delivery Replay (#1063)

`POST /api/v1/admin/webhooks/deliveries/:deliveryId/replay` re-enqueues a past delivery
verbatim from the log, without re-indexing the underlying event. The clone is a new
`webhook_deliveries` row pointing back at its source:

```bash
POST /api/v1/admin/webhooks/deliveries/118/replay
→ 201 { "deliveryId": 205, "replayedFrom": 118, "webhookId": 42, "status": "queued" }
```

Replays inherit the same circuit breaker: a `409` is returned while the endpoint's
circuit is open. Requires an `admin` API key.

## Failure Escalation

A webhook may reference another webhook row via `fallback_channel`. After the primary
webhook exhausts its retry budget (6 attempts), a single delivery attempt of the same
payload is enqueued to the fallback webhook. The fallback is never used when the primary
delivers successfully.

## Admin Endpoints

### `GET /api/v1/admin/notifications/health`

Sends an HTTP `HEAD` request (3s timeout) to every active webhook URL and reports
reachability:

```json
{
  "channels": [
    { "id": 1, "url": "https://example.com/hook", "reachable": true, "latencyMs": 84 },
    { "id": 2, "url": "https://down.example.com/hook", "reachable": false, "latencyMs": null }
  ]
}
```

### `POST /api/v1/admin/notifications/preview`

Renders a notification template for an `(eventType, channel)` pair against a sample
payload, without sending anything. Requires an `admin` API key.

```json
POST /api/v1/admin/notifications/preview
{ "eventType": "deposit", "channel": "webhook", "samplePayload": { "data": { "amount": "100" } } }

→ 200 { "rendered": "Deposit of 100 into vault ." }
→ 404 { "error": "TemplateNotFound", ... }   // no template for the pair
```

Templates live in the `notification_templates` table and use `{{dotted.path}}`
placeholders resolved against the payload.

## Best Practices

- Always verify the signature before processing webhook events
- Use constant-time comparison to prevent timing attacks
- Respond with HTTP 200 within 5 seconds to prevent retries
- Process webhooks asynchronously to avoid blocking the response
- Store webhook secrets securely in environment variables
- Log all webhook events for debugging and audit purposes
