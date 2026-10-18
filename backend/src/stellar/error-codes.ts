/**
 * XDR-encoded Soroban contract error code translation table.
 *
 * Raw RPC simulation errors embed numeric error codes that are opaque to end
 * users. This module maps known codes to human-readable metadata so the
 * frontend can display actionable feedback.
 */

export interface ErrorTranslation {
  code: number;
  name: string;
  description: string;
  suggestedAction: string;
}

const UNKNOWN_TRANSLATION: Omit<ErrorTranslation, "code"> = {
  name: "UnknownError",
  description: "An unexpected contract error occurred. The vault may be in an incompatible state for the requested operation.",
  suggestedAction: "Please try again later or contact support if the issue persists.",
};

/**
 * Known `SingleRwaVault` contract error codes.
 *
 * The numeric values mirror the `#[contracterror]` enum in
 * `soroban-contracts/contracts/single_rwa_vault/src/errors.rs` — that file is
 * the single source of truth, so a new variant added there must be mirrored
 * here. Codes 2 and 23 are intentionally absent: the Rust enum never assigned
 * them, and Soroban encodes missing variants as gaps rather than renumbering.
 *
 * `VaultFactory` uses a separate, independent numbering
 * (`soroban-contracts/contracts/vault_factory/src/errors.rs`) and is not
 * translated here.
 */
const ERROR_CODE_MAP: Record<number, Omit<ErrorTranslation, "code">> = {
  1: {
    name: "NotKYCVerified",
    description: "The user's address has not been KYC-verified for this vault. Deposits are blocked until verification completes.",
    suggestedAction: "Complete the KYC verification process before attempting to deposit.",
  },
  3: {
    name: "NotOperator",
    description: "The caller is not registered as an operator of this vault.",
    suggestedAction: "Call the function from an address holding the operator role.",
  },
  4: {
    name: "NotAdmin",
    description: "The caller does not hold the vault admin role.",
    suggestedAction: "Call the function from the vault admin address.",
  },
  5: {
    name: "InvalidVaultState",
    description: "The vault is not in the state this operation requires.",
    suggestedAction: "Check the vault's current state and retry once it matches the required lifecycle state.",
  },
  6: {
    name: "BelowMinimumDeposit",
    description: "The deposit amount is below the vault's configured minimum deposit.",
    suggestedAction: "Increase the deposit amount to meet the minimum threshold.",
  },
  7: {
    name: "ExceedsMaximumDeposit",
    description: "The deposit would exceed the vault's configured maximum deposit limit.",
    suggestedAction: "Reduce the deposit amount to stay within the vault's maximum.",
  },
  8: {
    name: "NotMatured",
    description: "The maturity date has not been reached yet, so the vault cannot transition to the Matured state.",
    suggestedAction: "Wait until the vault's maturity date has passed before attempting to mature it.",
  },
  9: {
    name: "NoYieldToClaim",
    description: "The caller has no pending yield available to claim.",
    suggestedAction: "Check the claimable yield balance; there may be nothing left to claim.",
  },
  10: {
    name: "FundingTargetNotMet",
    description: "The vault's funding target has not been reached, so it cannot activate (or cannot be cancelled as a failed round).",
    suggestedAction: "Wait for more deposits so the funding target is met before activating the vault.",
  },
  11: {
    name: "VaultPaused",
    description: "The vault is paused. No state-changing operations are accepted while paused.",
    suggestedAction: "Wait for the operator to unpause the vault, then retry.",
  },
  12: {
    name: "ZeroAddress",
    description: "A zero address was supplied where a real address is required.",
    suggestedAction: "Provide a valid Stellar address.",
  },
  13: {
    name: "ZeroAmount",
    description: "A zero amount was supplied where a positive amount is required.",
    suggestedAction: "Provide a positive, non-zero amount.",
  },
  14: {
    name: "AddressBlacklisted",
    description: "The address is blacklisted by the vault and may not interact with it.",
    suggestedAction: "Use a different address; blacklisted addresses are blocked by compliance rules.",
  },
  15: {
    name: "Reentrant",
    description: "A reentrant call was detected: a guarded function was re-entered while it was still executing.",
    suggestedAction: "Retry the transaction. If it keeps failing, the calling contract is performing a reentrant call and must be fixed.",
  },
  16: {
    name: "FundingDeadlinePassed",
    description: "The vault's funding deadline has passed, so it can no longer be activated.",
    suggestedAction: "The funding round has expired — the vault must be cancelled and depositors refunded.",
  },
  17: {
    name: "FundingDeadlineNotPassed",
    description: "The funding deadline has not passed yet, so a failed funding round cannot be cancelled early.",
    suggestedAction: "Wait until the funding deadline elapses before cancelling the funding round.",
  },
  18: {
    name: "NoSharesToRefund",
    description: "The caller holds no shares from the cancelled funding round, so there is nothing to refund.",
    suggestedAction: "Check the share balance for this vault; only original depositors are refunded.",
  },
  19: {
    name: "InsufficientAllowance",
    description: "The token allowance granted to the vault is lower than the amount being moved.",
    suggestedAction: "Approve a larger allowance for the vault before retrying.",
  },
  20: {
    name: "InsufficientBalance",
    description: "The account balance is too low to cover the requested operation.",
    suggestedAction: "Fund the account with enough assets to cover the operation.",
  },
  21: {
    name: "AlreadyProcessed",
    description: "The operation has already been processed and cannot be repeated.",
    suggestedAction: "Refresh your view of the vault state — the operation already succeeded.",
  },
  22: {
    name: "FeeTooHigh",
    description: "The requested fee exceeds the maximum fee the vault permits.",
    suggestedAction: "Lower the fee to at most the vault's maximum permitted fee.",
  },
  24: {
    name: "InvalidRedemptionRequest",
    description: "The referenced redemption request ID is invalid, unknown, or not owned by the caller.",
    suggestedAction: "Use a redemption request ID that exists and belongs to the calling address.",
  },
  25: {
    name: "NotSupported",
    description: "The requested operation or asset type is not supported by this contract.",
    suggestedAction: "Check that the asset and operation are supported before retrying.",
  },
  26: {
    name: "InvalidInitParams",
    description: "The initialization parameters supplied to the constructor are invalid.",
    suggestedAction: "Re-deploy the vault with valid constructor parameters.",
  },
  27: {
    name: "VaultNotEmpty",
    description: "The vault still holds shares or assets, so it cannot be closed.",
    suggestedAction: "Redeem or refund all remaining shares and assets before closing the vault.",
  },
  28: {
    name: "InvalidEpochRange",
    description: "The requested epoch range is invalid — it is empty, reversed, or larger than the maximum batch of 50 epochs.",
    suggestedAction: "Submit an epoch range with a start below the end, at least one epoch, and no more than 50 epochs.",
  },
  29: {
    name: "NotInEmergency",
    description: "The vault is not in the Emergency state, so emergency-only operations are rejected.",
    suggestedAction: "Only emergency procedures are available once the vault has entered the Emergency state.",
  },
  30: {
    name: "AlreadyClaimedEmergency",
    description: "The caller has already claimed their emergency distribution.",
    suggestedAction: "Refresh your position — the emergency distribution has already been paid out.",
  },
  31: {
    name: "MigrationRequired",
    description: "The vault's storage schema is outdated; the migration entrypoint must be called before further use.",
    suggestedAction: "Call the contract's migrate() function to upgrade the storage schema.",
  },
  32: {
    name: "BurnRequiresYieldClaim",
    description: "Shares cannot be burned while yield is still pending — claim the yield first.",
    suggestedAction: "Claim the pending yield, then burn the shares.",
  },
  33: {
    name: "InvalidDepositLimits",
    description: "The configured deposit limits are invalid (minimum above maximum, or a zero value).",
    suggestedAction: "Update the deposit limits to a valid range before depositing.",
  },
  34: {
    name: "TimelockActionNotFound",
    description: "The referenced timelock action does not exist or is invalid.",
    suggestedAction: "Check the action ID — the timelock action is unknown or was never scheduled.",
  },
  35: {
    name: "TimelockDelayNotPassed",
    description: "The timelock delay has not elapsed yet, so the action cannot be executed.",
    suggestedAction: "Wait until the timelock delay has passed, then execute the action.",
  },
  36: {
    name: "TimelockActionAlreadyExecuted",
    description: "The timelock action has already been executed.",
    suggestedAction: "Refresh your view of the timelock queue — the action has already run.",
  },
  37: {
    name: "TimelockActionCancelled",
    description: "The timelock action has been cancelled.",
    suggestedAction: "Schedule a new timelock action if the operation is still required.",
  },
  38: {
    name: "TimelockAdminOnly",
    description: "Timelock operations are restricted to the vault admin.",
    suggestedAction: "Submit the timelock request from the vault admin address.",
  },
  39: {
    name: "NotEmergencySigner",
    description: "The caller is not one of the vault's emergency signers.",
    suggestedAction: "Submit the emergency proposal from a registered emergency signer address.",
  },
  40: {
    name: "ProposalNotFound",
    description: "The referenced emergency proposal does not exist.",
    suggestedAction: "Check the proposal ID — no such proposal exists.",
  },
  41: {
    name: "ProposalExpired",
    description: "The emergency proposal has passed its expiry window and can no longer be executed.",
    suggestedAction: "Create a new emergency proposal.",
  },
  42: {
    name: "ProposalAlreadyExecuted",
    description: "The emergency proposal has already been executed.",
    suggestedAction: "Refresh your view of the proposals — this one has already been applied.",
  },
  43: {
    name: "ThresholdNotMet",
    description: "The multi-signer approval threshold has not been reached for this proposal.",
    suggestedAction: "Collect more signer approvals before executing the proposal.",
  },
  44: {
    name: "AlreadyApproved",
    description: "This signer has already approved the proposal.",
    suggestedAction: "No action needed — the approval is already recorded.",
  },
  45: {
    name: "InvalidThreshold",
    description: "The approval threshold must be at least 1 and no greater than the number of signers.",
    suggestedAction: "Set a threshold between 1 and the number of registered signers.",
  },
  46: {
    name: "FundingTargetExceeded",
    description: "The operation would push total assets above the vault's funding target while it is still in the Funding phase.",
    suggestedAction: "Reduce the deposit amount so total assets do not exceed the funding target.",
  },
  47: {
    name: "PreviewZeroShares",
    description: "The deposit previews to zero shares.",
    suggestedAction: "Increase the deposit amount — it currently rounds down to zero shares.",
  },
  48: {
    name: "PreviewZeroAssets",
    description: "The redemption previews to zero assets.",
    suggestedAction: "Increase the number of shares being redeemed so the result is above zero.",
  },
  49: {
    name: "TransferExemptionLimitExceeded",
    description: "Too many transfer-exempt addresses have been configured for this vault.",
    suggestedAction: "Remove some transfer-exempt addresses before adding new ones.",
  },
  50: {
    name: "NoShareholders",
    description: "The vault has no shareholders, so there is nobody to distribute yield to.",
    suggestedAction: "Wait until the vault has shareholders before distributing yield.",
  },
  51: {
    name: "YieldShortfallNotFound",
    description: "No yield shortfall is recorded for this user.",
    suggestedAction: "Refresh your position — there is no recorded shortfall to resolve.",
  },
  52: {
    name: "InsufficientShortfall",
    description: "The resolution amount is greater than the recorded yield shortfall.",
    suggestedAction: "Resolve at most the recorded shortfall amount.",
  },
};

/**
 * Translate a numeric Soroban error code into a human-readable description.
 *
 * @param errorCode - The numeric error code from the XDR simulation error.
 * @returns A full `ErrorTranslation` object including the original code.
 */
export function translateErrorCode(errorCode: number): ErrorTranslation {
  const entry = ERROR_CODE_MAP[errorCode];
  if (entry) {
    return { code: errorCode, ...entry };
  }
  return { code: errorCode, ...UNKNOWN_TRANSLATION };
}
