# 🌍 Kindred AidTrail Registry API

[![CI / Build, Test & Lint](https://github.com/Kindred-AidTrail/Aidtrail-registry-api/actions/workflows/ci.yml/badge.svg)](https://github.com/Kindred-AidTrail/Aidtrail-registry-api/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-20%20%7C%2022-brightgreen.svg)](https://nodejs.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5.x-black.svg)](https://www.fastify.io/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-blue.svg)](https://www.postgresql.org/)
[![Prisma](https://img.shields.io/badge/Prisma-6.x-2D3748.svg)](https://www.prisma.io/)
[![Stellar / Soroban](https://img.shields.io/badge/Stellar-Testnet-7D00FF.svg)](https://stellar.org/)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

> Production-grade off-chain registry, cryptographic onboarding gateway, real-time Soroban event indexer, and public transparent audit API for the **Kindred AidTrail** humanitarian aid disbursement platform.

---

## 📑 Table of Contents
- [Architecture Overview](#-architecture-overview)
- [Threat Model & Security Design](#-threat-model--security-design)
- [Key Features](#-key-features)
- [Tech Stack](#-tech-stack)
- [Getting Started](#-getting-started)
- [Docker Compose Quickstart](#-docker-compose-quickstart)
- [Database Setup & Seeding](#-database-setup--seeding)
- [Running the Services](#-running-the-services)
- [API Reference](#-api-reference)
- [Event Indexer & Reorg Safety](#-event-indexer--reorg-safety)
- [Management CLI](#-management-cli)
- [Testing & Quality Assurance](#-testing--quality-assurance)

---

## 🏛 Architecture Overview

AidTrail decouples private personal identification from public cryptographic verification:

```mermaid
flowchart TD
    subgraph Client Apps
        D[AidTrail Dashboard / Mobile]
        F[Freighter / SEP-10 Wallet]
    end

    subgraph AidTrail Registry API [Fastify Engine]
        AUTH[SEP-10 Challenge & JWT]
        ONBOARD[Onboarding & GDPR Engine]
        CRYPTO[AES-256-GCM Field Crypto]
        DISPATCH[Soroban RPC Dispatcher]
        AUDIT[Public Audit & CSV Streamer]
        HOOKS[HMAC Webhook Dispatcher]
    end

    subgraph Data Stores
        PG[(PostgreSQL 16 / Prisma)]
        S3[(MinIO / S3 Object Storage)]
    end

    subgraph Stellar Network
        RPC[Soroban RPC getEvents]
        CONTRACT[[AidTrail Soroban Contract]]
    end

    F -->|Sign Challenge| AUTH
    AUTH -->|Bearer Token| ONBOARD
    ONBOARD -->|Encrypt PII| CRYPTO
    CRYPTO -->|Encrypted Records| PG
    ONBOARD -->|Upload Documents| S3
    ONBOARD -->|Doc Hashes| PG
    DISPATCH -->|register_vendor| CONTRACT
    RPC -->|Event Stream| DISPATCH
    DISPATCH -->|Idempotent Indexing| PG
    PG -->|Read Queries| AUDIT
    PG -->|Event Trigger| HOOKS
```

---

## 🛡 Threat Model & Security Design

| Threat | Impact | Mitigation in AidTrail Registry API |
| :--- | :--- | :--- |
| **SEP-10 Challenge Replay** | Attacker replays signed challenge to steal session | Server enforces 300s strict timebounds (`minTime`/`maxTime`), sequence number 0, and single-use 64-byte cryptographic nonces per challenge. |
| **PII Data Breach (SQL Dump)** | Exfiltrated database exposes names, phones, emails of vulnerable refugees | **Zero Plaintext at Rest**: Legal names, phones, and emails are encrypted with AES-256-GCM before reaching the database. Cryptographic shredding zeroes keys on GDPR erasure. |
| **Document Forgery in S3** | Rogue actor replaces uploaded KYC/business license in object storage | Every upload computes a SHA-256 hash stored in PostgreSQL and S3 object metadata. `verifyDocumentIntegrity()` rejects mismatched payloads. |
| **Reorg / RPC Node Fork** | Chain reorganization causes duplicated voucher issuance or stale state | Indexer incorporates a 4-ledger confirmation window, unique `eventId` idempotency guards, and automatic `rewindCursorForReorg()` state rollback. |
| **Beneficiary Address Surveillance** | Public observers track aid recipients by public key | **Pseudonymous Salted Hashes**: Public audit endpoints replace Stellar addresses with `anon_<hash>` derived from HMAC-SHA256 peppers. |
| **Webhook Spoofing / Tampering** | Attacker impersonates AidTrail API to forge NGO milestone notifications | Outgoing webhooks are signed using `HMAC-SHA256` with per-NGO secrets in header `X-AidTrail-Signature: t=<timestamp>,v1=<hash>`. |
| **Denial of Service (DDoS)** | Spam requests exhaust server resources | Configured `@fastify/rate-limit` (120 req/min per IP) and strict multipart file size enforcement (10 MB limit). |

---

## 🚀 Key Features

1. **SEP-10 Stellar Web Authentication**:
   - Compliant with Stellar Ecosystem Proposal 10 (SEP-0010).
   - Generates and verifies challenge envelopes; returns typed JWT bearer tokens with Role-Based Access Control (`DONOR`, `NGO`, `VERIFIER`, `BENEFICIARY`, `VENDOR`, `ADMIN`).
2. **Onboarding with Field-Level Encryption & S3 Intake**:
   - Beneficiaries and vendors submit credentials with zero-plaintext PII exposure.
   - S3-compatible document storage (AWS S3 or MinIO) with SHA-256 integrity verification.
3. **On-Chain Admin/NGO Approval Dispatch**:
   - Authorized admins approve pending vendors, automatically signing and invoking `register_vendor` on the Soroban smart contract.
4. **Resilient Soroban Event Indexer**:
   - Continuous polling worker for Soroban RPC `getEvents`.
   - Comprehensive decoding of all 14 contract event topics: `program:created`, `program:funded`, `program:cancel`, `program:refund`, `milestn:added`, `milestn:apprvd`, `milestn:release`, `vendor:reg`, `vendor:rem`, `voucher:issued`, `voucher:redeem`, `voucher:reclaim`, `contract:init`, `contract:paused`.
5. **Public Transparent Audit API**:
   - Zero-login read endpoints for donors, researchers, and public watchdogs.
   - Real-time solvency invariant checking: $\text{funded} \ge \text{released} \ge \text{allocated} \ge \text{redeemed} + \text{reclaimed}$.
   - High-throughput streaming CSV exports for disbursements and milestones.
6. **NGO Webhook Dispatcher**:
   - NGO subscription management with HMAC-SHA256 signatures and exponential backoff retry.
7. **GDPR Compliance**:
   - Article 20: Complete JSON data export with presigned S3 download links.
   - Article 17: Cryptographic right-to-erasure and physical S3 document purging.

---

## 🛠 Tech Stack

- **Runtime**: Node.js 20+ / 22+ (TypeScript ES2022 / NodeNext)
- **Web Framework**: Fastify 5.x
- **Database & ORM**: PostgreSQL 16, Prisma 6.x
- **Stellar SDK**: `@stellar/stellar-sdk` 13.x
- **Object Storage**: AWS SDK v3 (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`)
- **Documentation**: OpenAPI 3.0 via `@fastify/swagger` and Swagger UI
- **Testing**: Vitest 3.x, Supertest

---

## ⚙️ Getting Started

### 1. Prerequisites
- Node.js >= 20.0.0
- Docker and Docker Compose
- Stellar CLI (optional, for testnet deployer operations)

### 2. Installation
```bash
git clone https://github.com/Kindred-AidTrail/Aidtrail-registry-api.git
cd Aidtrail-registry-api
npm install
```

### 3. Environment Setup
Copy the provided `.env.example` template:
```bash
cp .env.example .env
```

Key environment configurations:
```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/aidtrail_registry?schema=public"
SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"
CONTRACT_ID="CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM"
SERVER_HOME_DOMAIN="api.aidtrail.kindred.org"
JWT_SECRET="your-32-character-secret-key-here"
PII_ENCRYPTION_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
S3_ENDPOINT="http://localhost:9000"
S3_BUCKET_NAME="aidtrail-documents"
```

---

## 🐳 Docker Compose Quickstart

Launch PostgreSQL and MinIO S3 object storage with auto-provisioned bucket:
```bash
docker compose up -d
```

Verify services:
- **PostgreSQL**: `localhost:5432` (user: `postgres`, password: `postgres`)
- **MinIO Console**: `http://localhost:9001` (user: `minioadmin`, password: `minioadmin`)
- **MinIO S3 API**: `http://localhost:9000`

---

## 🗄 Database Setup & Seeding

```bash
# Generate Prisma Client
npm run prisma:generate

# Push schema changes to database
npx prisma db push

# Seed testnet Admin, NGO, Verifiers, Vendors, Beneficiaries, and Program
npm run prisma:seed
```

---

## 🚦 Running the Services

### Start API Web Server:
```bash
# Development mode with hot-reload
npm run dev

# Production build and run
npm run build
npm start
```
- API Base URL: `http://localhost:4000`
- Swagger UI Documentation: `http://localhost:4000/docs`
- Healthcheck: `http://localhost:4000/health`

### Start Soroban Event Indexer Daemon:
```bash
npm run indexer
```

---

## 📖 API Reference

### 🔐 Authentication (`/api/v1/auth`)
| Method | Endpoint | Description | Auth |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/auth/challenge?account=G...` | Generate SEP-10 challenge transaction | Public |
| `POST` | `/api/v1/auth/token` | Submit signed challenge, receive JWT | Public |
| `GET` | `/api/v1/auth/me` | Inspect current authenticated session | Bearer |

### 👥 Onboarding & Profiles
| Method | Endpoint | Description | Auth |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/beneficiaries/onboard` | Onboard beneficiary with encrypted PII & KYC | Bearer |
| `GET` | `/api/v1/beneficiaries/profile` | Get decrypted profile and document statuses | Beneficiary |
| `GET` | `/api/v1/beneficiaries/vouchers` | List claimable and redeemed vouchers | Beneficiary |
| `POST` | `/api/v1/vendors/onboard` | Apply for vendor qualification & category | Bearer |
| `GET` | `/api/v1/vendors/profile` | Get vendor status and registration details | Vendor |
| `GET` | `/api/v1/vendors/payouts` | Get history of on-chain payouts | Vendor |

### 🛡 Admin & NGO Operations (`/api/v1/admin`)
| Method | Endpoint | Description | Auth |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/admin/vendors/pending` | List pending vendor applications | NGO/Admin |
| `POST` | `/api/v1/admin/vendors/:id/approve` | Approve vendor & call on-chain `register_vendor` | NGO/Admin |
| `POST` | `/api/v1/admin/vendors/:id/reject` | Reject vendor onboarding application | NGO/Admin |
| `GET` | `/api/v1/admin/audit-logs` | View administrative audit log | Admin |

### 🔍 Public Transparency & Audit (`/api/v1/audit`)
| Method | Endpoint | Description | Auth |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/audit/programs` | Paginated aid programs with financial totals | Public |
| `GET` | `/api/v1/audit/programs/:id` | Program breakdown with milestone evidence & solvency | Public |
| `GET` | `/api/v1/audit/donors/totals` | Aggregate capital flows & donor leaderboard | Public |
| `GET` | `/api/v1/audit/milestones` | Milestone verification attestations feed | Public |
| `GET` | `/api/v1/audit/vouchers` | Pseudonymous voucher transparency feed | Public |
| `GET` | `/api/v1/audit/vendors/payouts` | Vendor payout history with explorer links | Public |
| `GET` | `/api/v1/audit/summary` | Global platform disbursement metrics | Public |
| `GET` | `/api/v1/audit/export/csv?type=disbursements` | Tamper-evident streaming disbursements CSV | Public |
| `GET` | `/api/v1/audit/export/csv?type=milestones` | Tamper-evident streaming milestones CSV | Public |

### 🔔 Webhooks & GDPR
| Method | Endpoint | Description | Auth |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/webhooks` | Register NGO webhook with HMAC secret | NGO/Admin |
| `GET` | `/api/v1/webhooks` | List registered webhooks | NGO/Admin |
| `POST` | `/api/v1/webhooks/:id/test` | Dispatch test ping event | NGO/Admin |
| `DELETE` | `/api/v1/webhooks/:id` | Unsubscribe webhook | NGO/Admin |
| `GET` | `/api/v1/gdpr/export` | Download full decrypted personal data archive | Bearer |
| `DELETE` | `/api/v1/gdpr/forget` | Execute right-to-erasure (S3 + DB shredding) | Bearer |

---

## 🔄 Event Indexer & Reorg Safety

The indexer worker polls Soroban RPC `getEvents`:
- **Ledger Cursor Tracking**: Persists the latest indexed ledger and event cursor into table `IndexerCursor`.
- **Reorg Safe**: Detects if remote ledger sequence regresses; rewinds to safe confirmation window.
- **Strict Idempotency**: All events pass through `ContractEvent` with unique constraint on `eventId`. Duplicate events are skipped without state side effects.

---

## 🧰 Management CLI

The built-in operational CLI assists node operators:
```bash
# View indexer cursor, event counts, and database health
npm run cli -- status

# Test connection to Soroban RPC node
npm run cli -- test-rpc

# Generate secure AES-256 key and Stellar testnet keypair
npm run cli -- gen-key

# Manually reset indexer cursor to specific ledger
npm run cli -- reset-cursor 1042000

# Rollback state in case of deep chain fork
npm run cli -- reorg-rollback 1041990
```

---

## 🧪 Testing & Quality Assurance

Run the automated test suite with Vitest:
```bash
npm test
```
The test suite covers:
- SEP-10 challenge generation, cryptographic signature validation, and replay rejection
- Role-based access control guard evaluation
- Beneficiary & Vendor onboarding with AES-256-GCM encryption
- Admin approval pipeline invoking Soroban RPC `register_vendor`
- Soroban event decoding, topic discrimination, and idempotent database synchronization
- Reorg detection and cursor rollback
- Public audit metrics and CSV streaming export
- HMAC-SHA256 signed webhook dispatch
- GDPR data portability export and cryptographic right-to-erasure

---

## 📜 License

Licensed under the [Apache License, Version 2.0](LICENSE).
Part of the **Kindred AidTrail** humanitarian initiative.
