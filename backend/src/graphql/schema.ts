import { buildSchema } from "graphql";

export const schema = buildSchema(`
  type User {
    address: String!
    kycVerified: Boolean!
    createdAt: String!
  }

  type Epoch {
    epoch: Int!
    yieldAmount: String!
    totalShares: String!
    yieldPerShare: String!
    distributedAt: String
  }

  type Vault {
    contractId: String!
    asset: String!
    name: String
    symbol: String
    state: String!
    totalAssets: String!
    totalSupply: String!
  }

  type ApiKey {
    id: ID!
    label: String
    role: String!
    createdAt: String!
  }

  type VaultTvlUpdate {
    contractId: String!
    tvlUsd: String!
    snapshotAt: String!
  }

  type Subscription {
    vaultTvlUpdated(contractId: String): VaultTvlUpdate!
  }

  type Query {
    health: String
    user(address: String!): User
    epochs(contractId: String!): [Epoch!]!
    apiKeys: [ApiKey!]!
    vaultsByStatus(status: String!): [Vault!]!
  }
`);

