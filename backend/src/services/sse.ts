import type { Response } from "express";
import { logger } from "../logger.js";
import { decrementSseConnections, incrementSseConnections } from "./metrics.js";

export interface SseClient {
  id: string;
  res: Response;
  ip: string;
  isAuthenticated: boolean;
  createdAt: Date;
}

export interface EpochRecordedEvent {
  type: "epoch_recorded";
  contractId: string;
  epoch: number;
  yieldAmount: string;
  timestamp: string;
}

export interface WebhookDeliveryEvent {
  type: "delivery";
  attempt: number;
  statusCode: number | null;
  durationMs: number;
  success: boolean;
}

type AnyEvent = EpochRecordedEvent | WebhookDeliveryEvent;

class SseService {
  private clients: Map<string, SseClient> = new Map();
  private epochSubscribers: Map<string, Set<string>> = new Map();
  private webhookSubscribers: Map<number, Set<string>> = new Map();
  private clientCounter = 0;

  registerClient(res: Response, ip: string, isAuthenticated: boolean): string {
    const clientId = `${Date.now()}-${++this.clientCounter}`;
    const client: SseClient = {
      id: clientId,
      res,
      ip,
      isAuthenticated,
      createdAt: new Date(),
    };
    this.clients.set(clientId, client);
    // Prometheus gauge for capacity planning (#1092)
    incrementSseConnections();
    logger.info({ clientId, ip, isAuthenticated }, "SSE client registered");
    return clientId;
  }

  unregisterClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    this.clients.delete(clientId);
    decrementSseConnections();

    for (const subscribers of this.epochSubscribers.values()) {
      subscribers.delete(clientId);
    }

    for (const subscribers of this.webhookSubscribers.values()) {
      subscribers.delete(clientId);
    }

    logger.info({ clientId, ip: client.ip }, "SSE client unregistered");
  }

  subscribeToEpoch(clientId: string, contractId: string): void {
    if (!this.clients.has(clientId)) return;
    if (!this.epochSubscribers.has(contractId)) {
      this.epochSubscribers.set(contractId, new Set());
    }
    this.epochSubscribers.get(contractId)!.add(clientId);
  }

  subscribeToWebhook(clientId: string, webhookId: number): void {
    if (!this.clients.has(clientId)) return;
    if (!this.webhookSubscribers.has(webhookId)) {
      this.webhookSubscribers.set(webhookId, new Set());
    }
    this.webhookSubscribers.get(webhookId)!.add(clientId);
  }

  broadcastEpochRecorded(contractId: string, event: EpochRecordedEvent): void {
    const subscribers = this.epochSubscribers.get(contractId);
    if (!subscribers || subscribers.size === 0) return;

    for (const clientId of subscribers) {
      const client = this.clients.get(clientId);
      if (!client) {
        subscribers.delete(clientId);
        continue;
      }

      this.sendEvent(client.res, event);
    }
  }

  broadcastWebhookDelivery(webhookId: number, event: WebhookDeliveryEvent): void {
    const subscribers = this.webhookSubscribers.get(webhookId);
    if (!subscribers || subscribers.size === 0) return;

    for (const clientId of subscribers) {
      const client = this.clients.get(clientId);
      if (!client) {
        subscribers.delete(clientId);
        continue;
      }

      this.sendEvent(client.res, event);
    }
  }

  getConnectedClientsForIp(ip: string): number {
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.ip === ip) count++;
    }
    return count;
  }

  getUnauthenticatedClientsForIp(ip: string): number {
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.ip === ip && !client.isAuthenticated) count++;
    }
    return count;
  }

  private sendEvent(res: Response, event: AnyEvent): void {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (err) {
      logger.warn({ err }, "Failed to write SSE event");
    }
  }
}

export const sseService = new SseService();
