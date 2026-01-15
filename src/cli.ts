import "dotenv/config";
import { createInterface } from "readline/promises";
import { WebSocket } from "ws";
import * as bip39 from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk-hd";
import { createKeystore, PublicKey as UnshieldedPublicKey, UnshieldedWallet, InMemoryTransactionHistoryStorage, type UnshieldedKeystore } from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
import {ShieldedWallet} from "@midnight-ntwrk/wallet-sdk-shielded";
import {DustWallet} from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import { NetworkId } from "@midnight-ntwrk/wallet-sdk-abstractions";
import * as ledgerV6 from "@midnight-ntwrk/ledger-v6";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import chalk from "chalk";
import { firstValueFrom, filter, take, shareReplay, Subscription, throttleTime } from "rxjs";
import {WalletFacade} from "@midnight-ntwrk/wallet-sdk-facade";

// @ts-ignore - Polyfill WebSocket for Node.js
globalThis.WebSocket = WebSocket;

// Configuration from environment
const CONFIG = {
  // Use separate URLs for HTTP and WebSocket
  indexerUrl: process.env.INDEXER_URL || "https://indexer.preview.midnight.network/api/v3/graphql",
  indexerWsUrl: process.env.INDEXER_WS_URL || "wss://indexer.preview.midnight.network/api/v3/graphql/ws",
  nodeUrl: process.env.RPC_URL || "wss://rpc.preview.midnight.network",
  proofServerUrl: process.env.PROOF_SERVER_URL || "http://localhost:6300",
  networkId: NetworkId.NetworkId.Preview
};

interface UserWallet {
  name: string;
  facade: WalletFacade;
  keystore: UnshieldedKeystore;
  keys: {
    night: Uint8Array;
    dust: ledgerV6.DustSecretKey;
    zswap: ledgerV6.ZswapSecretKeys;
  };
  addressBech32: string;
  dustAddressBech32: string;
}

// Derive keys for all 3 wallet roles from mnemonic
async function deriveWalletKeys(mnemonic: string) {
  if (!bip39.validateMnemonic(mnemonic, wordlist)) {
    throw new Error("Invalid mnemonic");
  }

  const seed = await bip39.mnemonicToSeed(mnemonic, "");
  const hdResult = HDWallet.fromSeed(new Uint8Array(seed));

  if (hdResult.type === 'seedError') {
    throw new Error(`HD Wallet creation failed: ${hdResult.error}`);
  }

  const hdWallet = hdResult.hdWallet;
  const account = hdWallet.selectAccount(0);
  
  // 1. Night (Unshielded) - keep as raw seed for keystore
  const nightDerivation = account.selectRole(Roles.NightExternal).deriveKeyAt(0);
  if (nightDerivation.type !== 'keyDerived') throw new Error("Failed to derive Night key");
  const nightKey = nightDerivation.key; // Raw seed bytes, not converted

  // 2. Dust (Fees)
  const dustDerivation = account.selectRole(Roles.Dust).deriveKeyAt(0);
  if (dustDerivation.type !== 'keyDerived') throw new Error("Failed to derive Dust key");
  const dustKey = ledgerV6.DustSecretKey.fromSeed(dustDerivation.key);

  // 3. Zswap (Shielded)
  const zswapDerivation = account.selectRole(Roles.Zswap).deriveKeyAt(0);
  if (zswapDerivation.type !== 'keyDerived') throw new Error("Failed to derive Zswap key");
  const zswapKey = ledgerV6.ZswapSecretKeys.fromSeed(zswapDerivation.key);
  
  return { night: nightKey, dust: dustKey, zswap: zswapKey };
}

// Create a WalletFacade combining all 3 wallet types
async function createWalletFacade(name: string, mnemonic: string): Promise<UserWallet> {
  console.log(chalk.gray(`  Creating ${name}'s combined wallet facade...`));
  
  const keys = await deriveWalletKeys(mnemonic);
  
  // Configuration matching the working example pattern
  const walletConfig = {
    networkId: CONFIG.networkId,
    costParameters: {
      additionalFeeOverhead: 300_000_000_000_000_000n, // Higher value from working example
      feeBlocksMargin: 5,
    },
    relayURL: new URL(CONFIG.nodeUrl),
    provingServerUrl: new URL(CONFIG.proofServerUrl),
    indexerClientConnection: {
      indexerHttpUrl: CONFIG.indexerUrl,
      indexerWsUrl: CONFIG.indexerWsUrl,
    },
    indexerUrl: CONFIG.indexerWsUrl,
  };
  
  // 1. Setup Unshielded Wallet - using createKeystore with raw seed bytes
  const keystore = createKeystore(keys.night, CONFIG.networkId);
  const addressBech32 = keystore.getBech32Address().toString();
  
  // Use UnshieldedWallet function (not WalletBuilder) matching working example
  const unshieldedWallet = UnshieldedWallet({
    ...walletConfig,
    txHistoryStorage: new InMemoryTransactionHistoryStorage(),
  } as any).startWithPublicKey(
    UnshieldedPublicKey.fromKeyStore(keystore)
  );

  // 2. Setup Shielded Wallet - pass secret keys directly
  const shieldedWallet = ShieldedWallet(walletConfig as any).startWithSecretKeys(keys.zswap);

  // 3. Setup Dust Wallet - use ledger parameters from ledger module
  const dustWallet = DustWallet(walletConfig as any).startWithSecretKey(
    keys.dust,
    ledgerV6.LedgerParameters.initialParameters().dust
  );

  // Combine into Facade
  const facade = new WalletFacade(shieldedWallet, unshieldedWallet, dustWallet);
  
  console.log(chalk.gray(`  Address: ${addressBech32}`));
  
  await facade.start(keys.zswap, keys.dust);
  
  // Get dust address from state
  const dustState = await firstValueFrom(facade.dust.state);
  const dustAddressBech32 = dustState.dustAddress;
  console.log(chalk.gray(`  Dust Address: ${dustAddressBech32}`));
  console.log(chalk.gray(`  Starting synchronization...`));

  return {
    name,
    facade,
    keystore,
    keys,
    addressBech32,
    dustAddressBech32
  };
}


function formatNight(value: bigint): string {
  const night = Number(value) / 1_000_000;
  return `${night.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })} NIGHT`;
}

// Format DUST balance for display (15 decimals)
function formatDust(value: bigint): string {
  const dust = Number(value / 1_000_000_000_000n) / 1_000; // Divide by 10^15
  return `${dust.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} DUST`;
}

// Wait for wallet facade to synchronize using the SDK's built-in isSynced property
async function waitForSync(facade: WalletFacade, name: string): Promise<void> {
  console.log(chalk.gray(`  Waiting for ${name}'s wallet facade to sync...`));
  let lastUpdate = 0;
  let debugLogged = false;
  
  await firstValueFrom(
    facade.state().pipe(
      filter((state) => {
        const stateAny = state as any;
        
        // Debug: Log the state structure once (uncomment for diagnostics)
        // if (!debugLogged) {
        //   const uProgress = stateAny.unshielded?.state?.progress;
        //   const sProgress = stateAny.shielded?.state?.progress;
        //   const dProgress = stateAny.dust?.state?.progress;
        //   
        //   console.log(chalk.yellow(`\n  DEBUG ${name} isSynced: ${stateAny.isSynced}`));
        //   console.log(chalk.yellow(`  DEBUG ${name} unshielded progress: appliedId=${uProgress?.appliedId}, highestTransactionId=${uProgress?.highestTransactionId}, isConnected=${uProgress?.isConnected}`));
        //   console.log(chalk.yellow(`  DEBUG ${name} shielded progress: appliedIndex=${sProgress?.appliedIndex}, highestRelevantIndex=${sProgress?.highestRelevantIndex}, isConnected=${sProgress?.isConnected}`));
        //   console.log(chalk.yellow(`  DEBUG ${name} dust progress: appliedIndex=${dProgress?.appliedIndex}, highestRelevantIndex=${dProgress?.highestRelevantIndex}, isConnected=${dProgress?.isConnected}`));
        //   debugLogged = true;
        // }
        
        // Use the SDK's built-in sync detection (matching the working example)
        const isSynced = stateAny.isSynced === true;
        
        const now = Date.now();
        if (now - lastUpdate > 2000 || isSynced) {
          // Progress is inside .state, not at root
          const uState = stateAny.unshielded?.state;
          const sState = stateAny.shielded?.state;
          const dState = stateAny.dust?.state;
          
          const uProgress = uState?.progress;
          const sProgress = sState?.progress;
          const dProgress = dState?.progress;
          
          const uInfo = uProgress?.appliedId !== undefined 
            ? `${uProgress.appliedId}/${uProgress.highestTransactionId || '?'}` : '?';
          const sInfo = sProgress?.appliedIndex !== undefined 
            ? `${sProgress.appliedIndex}/${sProgress.highestRelevantIndex || '?'}` : '?';
          const dInfo = dProgress?.appliedIndex !== undefined 
            ? `${dProgress.appliedIndex}/${dProgress.highestRelevantIndex || '?'}` : '?';
            
          process.stdout.write(
            chalk.gray(`\r  ${name} syncing... [U:${uInfo} S:${sInfo} D:${dInfo}] ${isSynced ? 'OK' : '...'}     `)
          );
          lastUpdate = now;
        }
        
        return isSynced;
      }),
      take(1)
    )
  );
  process.stdout.write(chalk.green(`\r✅ ${name} fully synced!                                 \n`));
}

// Transfer NIGHT tokens using WalletFacade
async function transferNight(
  from: UserWallet,
  toAddress: string,
  amount: bigint
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    console.log(chalk.yellow(`\nPreparing transfer of ${Number(amount) / 1_000_000} NIGHT...`));
    
    // 1. Create transfer transaction via facade
    // This handles unshielded NIGHT transfer + DUST fees automatically
    console.log(chalk.gray("  Creating transfer transaction..."));
    const nativeTokenType = "00".repeat(32);
    const ttl = new Date(Date.now() + 3600 * 1000); // 1 hour TTL
    
    const recipe = await from.facade.transferTransaction(
      from.keys.zswap,
      from.keys.dust,
      [{
        type: 'unshielded',
        outputs: [{ amount, type: nativeTokenType, receiverAddress: toAddress }]
      }],
      ttl
    );

    // 2. Sign the transaction using keystore (matching working example pattern)
    console.log(chalk.gray("  Signing transaction..."));
    const signedTx = await from.facade.signTransaction(
      recipe.transaction,
      (data: Uint8Array) => from.keystore.signData(data)
    );

    // 3. Prove transaction (ZK proofs for DUST fees and any shielded parts)
    console.log(chalk.gray("  Proving transaction..."));
    const finalizedTx = await from.facade.finalizeTransaction({ 
      type: 'TransactionToProve', 
      transaction: signedTx 
    });
    
    // 4. Submit to node
    console.log(chalk.gray("  Submitting to node..."));
    console.log(chalk.gray("    (Sending to mempool...)"));
    const txId = await from.facade.submitTransaction(finalizedTx);
    console.log(chalk.gray("    (Included in block!)"));
    
    console.log(chalk.green(`\n✅ Transaction submitted successfully!`));
    console.log(chalk.gray(`   Tx hash: ${txId}`));
    return { success: true, txHash: txId };

  } catch (error: any) {
    console.error(chalk.red(`\n❌ Transfer failed:`), error);
    return { success: false, error: String(error) };
  }
}

// Pre-flight health check for network services
async function checkServiceHealth(): Promise<void> {
  const timeout = 10000; // 10 second timeout

  // Check Indexer HTTP endpoint
  console.log(chalk.gray("  Checking Indexer..."));
  try {
    const indexerResponse = await fetch(CONFIG.indexerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ __schema { types { name } } }' }),
      signal: AbortSignal.timeout(timeout),
    });
    
    if (!indexerResponse.ok) {
      throw new Error(`Indexer returned ${indexerResponse.status}: ${indexerResponse.statusText}`);
    }
    console.log(chalk.green("    ✓ Indexer HTTP OK"));
  } catch (error: any) {
    console.error(chalk.red(`\n❌ Indexer service unavailable at ${CONFIG.indexerUrl}`));
    console.error(chalk.red(`   Error: ${error.message}`));
    console.error(chalk.yellow("\n   The Midnight Preview Network indexer may be experiencing issues."));
    console.error(chalk.yellow("   Please try again later or check network status at https://midnight.network"));
    process.exit(1);
  }

  // Check RPC endpoint (JSON-RPC health check)
  console.log(chalk.gray("  Checking RPC Node..."));
  try {
    // For WSS, we can't easily test via fetch, so test the HTTPS version
    const rpcHttpUrl = CONFIG.nodeUrl.replace('wss://', 'https://').replace('ws://', 'http://');
    const rpcResponse = await fetch(rpcHttpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'system_health', params: [], id: 1 }),
      signal: AbortSignal.timeout(timeout),
    });
    
    if (!rpcResponse.ok) {
      throw new Error(`RPC node returned ${rpcResponse.status}: ${rpcResponse.statusText}`);
    }
    console.log(chalk.green("    ✓ RPC Node OK"));
  } catch (error: any) {
    console.error(chalk.red(`\n❌ RPC node unavailable at ${CONFIG.nodeUrl}`));
    console.error(chalk.red(`   Error: ${error.message}`));
    console.error(chalk.yellow("\n   The Midnight Preview Network RPC node may be experiencing issues."));
    console.error(chalk.yellow("   Please try again later or check network status at https://midnight.network"));
    process.exit(1);
  }

  // Check Proof Server (local)
  console.log(chalk.gray("  Checking Proof Server..."));
  try {
    const proofResponse = await fetch(CONFIG.proofServerUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(timeout),
    });
    // Proof server may return various status codes, as long as it responds we're OK
    console.log(chalk.green("    ✓ Proof Server OK"));
  } catch (error: any) {
    console.error(chalk.red(`\n❌ Proof server unavailable at ${CONFIG.proofServerUrl}`));
    console.error(chalk.red(`   Error: ${error.message}`));
    console.error(chalk.yellow("\n   Make sure the proof server is running:"));
    console.error(chalk.cyan("     npm run proof-server"));
    console.error(chalk.gray("   Or manually with Docker:"));
    console.error(chalk.cyan("     docker run -p 6300:6300 midnightnetwork/proof-server:6.1.0-alpha.6 -- midnight-proof-server --network preview"));
    process.exit(1);
  }
}

// Main CLI loop
async function main() {
  // Suppress noisy SDK connection logs (all console methods - SDK uses log/warn/error)
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  const sdkLogFilter = (args: any[]): boolean => {
    const msg = args[0]?.toString() || '';
    // Do not filter any
    // return false;
    // Filter SDK logs that match known patterns
    return msg.includes('API-WS') || 
           msg.includes('RPC-CORE') || 
           msg.includes('API/INIT') ||
           /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/.test(msg); // Timestamped SDK logs
  };

  console.log = (...args: any[]) => {
    if (!sdkLogFilter(args)) originalLog.apply(console, args);
  };
  console.warn = (...args: any[]) => {
    if (!sdkLogFilter(args)) originalWarn.apply(console, args);
  };
  console.error = (...args: any[]) => {
    if (!sdkLogFilter(args)) originalError.apply(console, args);
  };

  console.log(chalk.cyan.bold("🌙 Night Token Transfer CLI (Alice <-> Bob)\n"));
  console.log(chalk.gray("Using Preview Network with WalletFacade (Combined Wallet)\n"));

  // Get mnemonics from environment
  const aliceMnemonic = process.env.ALICE_MNEMONIC;
  const bobMnemonic = process.env.BOB_MNEMONIC;

  if (!aliceMnemonic || !bobMnemonic) {
    console.error(chalk.red("❌ Missing ALICE_MNEMONIC or BOB_MNEMONIC in .env"));
    process.exit(1);
  }

  // Pre-flight service health checks
  console.log(chalk.yellow("Checking network services...\n"));
  await checkServiceHealth();
  console.log(chalk.green("✅ All services available\n"));

  // Initialize wallets
  console.log(chalk.yellow("Initializing Wallet Facades...\n"));

  let alice: UserWallet;
  let bob: UserWallet;

  try {
    alice = await createWalletFacade("Alice", aliceMnemonic);
    console.log(chalk.green(`✅ Alice Initialized\n`));

    bob = await createWalletFacade("Bob", bobMnemonic);
    console.log(chalk.green(`✅ Bob Initialized\n`));

    // Wait for both wallets to sync properly
    await waitForSync(alice.facade, "Alice");
    await waitForSync(bob.facade, "Bob");
    
    console.log(chalk.green(`\n✅ All wallets synced\n`));

  } catch (error: any) {
    console.error(chalk.red("Failed to initialize wallets:"), error.message);
    console.error(chalk.gray("Stack:"), error.stack);
    process.exit(1);
  }

  // Create readline interface for menu
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log(chalk.yellow("\nWallets initialized. Balances will update in the background.\n"));

  // Track balances reactively
  const nativeTokenType = "00".repeat(32);
  let aliceBalance = 0n;
  let bobBalance = 0n;

  // Store subscriptions for cleanup
  const subscriptions: Subscription[] = [];

  subscriptions.push(
    alice.facade.unshielded.state.pipe(
      throttleTime(2000)  // Only process every 2 seconds to reduce event loop pressure
    ).subscribe({
      next: (state) => {
        // balances is a Record<RawTokenType, bigint>, not a Map
        aliceBalance = (state as any).balances?.[nativeTokenType] || 0n;
      },
      error: (err) => {
        console.error(chalk.red('Alice unshielded subscription error:'), err.message);
      }
    })
  );

  let aliceDustBalance = 0n;
  subscriptions.push(
    alice.facade.dust.state.pipe(
      throttleTime(2000)
    ).subscribe({
      next: (state) => {
        aliceDustBalance = state.walletBalance(new Date());
      },
      error: (err) => {
        console.error(chalk.red('Alice dust subscription error:'), err.message);
      }
    })
  );

  subscriptions.push(
    bob.facade.unshielded.state.pipe(
      throttleTime(2000)
    ).subscribe({
      next: (state) => {
        // balances is a Record<RawTokenType, bigint>, not a Map
        bobBalance = (state as any).balances?.[nativeTokenType] || 0n;
      },
      error: (err) => {
        console.error(chalk.red('Bob unshielded subscription error:'), err.message);
      }
    })
  );

  let bobDustBalance = 0n;
  subscriptions.push(
    bob.facade.dust.state.pipe(
      throttleTime(2000)
    ).subscribe({
      next: (state) => {
        bobDustBalance = state.walletBalance(new Date());
      },
      error: (err) => {
        console.error(chalk.red('Bob dust subscription error:'), err.message);
      }
    })
  );

  // Cleanup function
  const cleanup = async () => {
    console.log(chalk.gray("\nCleaning up..."));
    subscriptions.forEach(sub => sub.unsubscribe());
    await alice.facade.stop();
    await bob.facade.stop();
    rl.close();
  };

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    await cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await cleanup();
    process.exit(0);
  });

  // Main menu loop - readline.question naturally yields to event loop
  while (true) {
    console.log(chalk.cyan("\n--- Current Balances ---"));
    console.log(`Alice: ${formatNight(aliceBalance)} (${formatDust(aliceDustBalance)})`);
    console.log(`Bob:   ${formatNight(bobBalance)} (${formatDust(bobDustBalance)})`);
    
    console.log(chalk.cyan("\n--- Menu ---"));
    console.log("1. Transfer NIGHT: Alice → Bob");
    console.log("2. Transfer NIGHT: Bob → Alice");
    console.log("3. Refresh Balances (Wait for sync)");
    console.log("4. Exit");

    const choice = await rl.question(chalk.yellow("\nChoice: "));

    switch (choice.trim()) {
      case "1": {
        const amountStr = await rl.question("Amount (NIGHT): ");
        const amount = BigInt(Math.floor(parseFloat(amountStr) * 1_000_000));
        if (amount > 0n) {
          await transferNight(alice, bob.addressBech32, amount);
        } else {
          console.log(chalk.red("Invalid amount"));
        }
        break;
      }
      case "2": {
        const amountStr = await rl.question("Amount (NIGHT): ");
        const amount = BigInt(Math.floor(parseFloat(amountStr) * 1_000_000));
        if (amount > 0n) {
          await transferNight(bob, alice.addressBech32, amount);
        } else {
          console.log(chalk.red("Invalid amount"));
        }
        break;
      }
      case "3":
        console.log(chalk.gray("Refreshing..."));
        break;
      case "4":
        await cleanup();
        process.exit(0);
      default:
        console.log(chalk.red("Invalid choice"));
    }
  }
}

main().catch((error) => {
  console.error(chalk.red("Fatal error:"), error);
  process.exit(1);
});
