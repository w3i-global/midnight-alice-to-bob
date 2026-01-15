# Night Token Transfer CLI (Alice <-> Bob)

A command-line interface tool for the **Midnight Preview Network** that demonstrates how to initialize multiple wallets, synchronize them, and perform unshielded **NIGHT token transfers** between two users (Alice and Bob).

## Features

- **WalletFacade Integration**: Combines Unshielded, Shielded, and Dust wallets into a single interface.
- **Preview Network**: Configured for the Midnight Preview testnet.
- **Service Health Checks**: Automatically verifies availability of Indexer, RPC Node, and Proof Server before starting.
- **Real-time Sync**: Displays synchronization progress for all wallet components.
- **Interactive Menu**: Simple CLI menu to transfer tokens and refresh balances.

## Prerequisites

- **Node.js** v18+
- **Docker** (for running the local proof server)
- **Midnight Network Access**:
  - RPC Endpoint (WSS)
  - Indexer Endpoint (HTTPS/WSS)
- **24-word Mnemonics**: For both Alice and Bob (funded with NIGHT on Preview).
- **Designated Wallets**: Both wallets should have been previously loaded in Lace and designated to themselves so that they generate DUST to fund the transfer transaction(s).

## Setup

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Configure Environment**
   Create a `.env` file in this directory with the following variables:

   ```env
   # Network Configuration
   MIDNIGHT_NETWORK=preview
   
   # Midnight Preview Network Endpoints
   RPC_URL=wss://rpc.preview.midnight.network
   INDEXER_URL=https://indexer.preview.midnight.network/api/v3/graphql
   INDEXER_WS_URL=wss://indexer.preview.midnight.network/api/v3/graphql/ws
   PROOF_SERVER_URL=http://localhost:6300

   # Wallet Mnemonics (24 words)
   ALICE_MNEMONIC="your alice mnemonic words here..."
   BOB_MNEMONIC="your bob mnemonic words here..."
   ```

3. **Start Proof Server**
   Run the local proof server using Docker:
   ```bash
   npm run proof-server
   ```
   *Or manually:*
   ```bash
   docker run -p 6300:6300 midnightnetwork/proof-server:6.1.0-alpha.6 -- midnight-proof-server --network preview
   ```

## Usage

1. **Build the Project**
   ```bash
   npm run build
   ```

2. **Run the CLI**
   ```bash
   npm run cli
   ```

### What to Expect

1. **Health Checks**: The tool first checks connectivity to the Indexer, RPC Node, and Proof Server.
2. **Initialization**: Wallet facades for Alice and Bob are created.
3. **Synchronization**: The tool waits for both wallets to fully sync with the network.
   - You will see progress like `[U:1234/1234 S:50/50 D:50/50]` indicating Unshielded, Shielded, and Dust sync status.
4. **Interactive Menu**:
   - `1`: Send 10 NIGHT from Alice to Bob
   - `2`: Send 10 NIGHT from Bob to Alice
   - `3`: Refresh balances (checks sync status again)
   - `4`: Exit

## Troubleshooting

- **Service Unavailable**: If the health check fails, ensure your internet connection works and that the Midnight Preview Network services are online (check https://midnight.network).
- **Proof Server Error**: Ensure Docker is running and port 6300 is available.
- **Sync Stuck**: If `isConnected=false` appears in debug logs (if enabled), the Indexer WebSocket might be unreachable.