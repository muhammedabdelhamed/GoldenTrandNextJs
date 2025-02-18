import { logError } from "@b/utils/logger";
import { models } from "@b/db";
import { storeAndBroadcastTransaction } from "@b/utils/eco/redis/deposit";

type ParsedTransaction = {
  timestamp: string;
  hash: string;
  from: string;
  to: string;
  amount: string;
  confirmations: string;
  status: string;
  isError: string;
  fee: string;
};

type WalletCreationResult = {
  address: string;
  data: {
    mnemonic: string;
  };
};

class MoneroService {
  private daemonRpcUrl: string;
  private walletRpcUrl: string;
  private rpcUser: string | undefined;
  private rpcPassword: string | undefined;
  private walletPassword: string | undefined;
  private chainActive: boolean = false;
  private static monitoredWallets = new Map<string, walletAttributes>();

  private static walletQueues: Map<string, (() => Promise<void>)[]> = new Map(); // Separate queue per wallet
  private static walletProcessing: Map<string, boolean> = new Map(); // Processing status per wallet
  private static queue: (() => Promise<void>)[] = []; // Global queue for sequential RPC access
  private static processingQueue = false;
  private static processedTransactions = new Set<string>();

  private static instance: MoneroService;

  private static readonly MIN_CONFIRMATIONS = 6;
  private static readonly MAX_RETRIES = 60; // Max retries (1 hour of checks every minute)
  private static readonly RETRY_INTERVAL = 60000; // 1 minute

  private constructor(
    daemonRpcUrl: string = "http://127.0.0.1:18081/json_rpc",
    walletRpcUrl: string = "http://127.0.0.1:18083/json_rpc",
    rpcUser: string | undefined = process.env.XMR_RPC_USER,
    rpcPassword: string | undefined = process.env.XMR_RPC_PASSWORD
  ) {
    this.daemonRpcUrl = daemonRpcUrl;
    this.walletRpcUrl = walletRpcUrl;
    this.rpcUser = rpcUser;
    this.rpcPassword = rpcPassword;
  }

  public static async getInstance(): Promise<MoneroService> {
    if (!MoneroService.instance) {
      MoneroService.instance = new MoneroService();
      await MoneroService.instance.checkChainStatus();
    }
    return MoneroService.instance;
  }

  private static async addToQueue(
    operation: () => Promise<void>
  ): Promise<void> {
    MoneroService.queue.push(operation);
    if (!MoneroService.processingQueue) {
      await MoneroService.processQueue();
    }
  }

  private static async processQueue(): Promise<void> {
    MoneroService.processingQueue = true;
    while (MoneroService.queue.length > 0) {
      const operation = MoneroService.queue.shift();
      if (operation) {
        try {
          await operation();
        } catch (error) {
          console.error(
            `Error processing global wallet operation: ${error.message}`
          );
        }
      }
    }
    MoneroService.processingQueue = false;
  }

  private static async addToWalletQueue(
    walletId: string,
    operation: () => Promise<void>
  ): Promise<void> {
    if (!MoneroService.walletQueues.has(walletId)) {
      MoneroService.walletQueues.set(walletId, []);
    }
    MoneroService.walletQueues.get(walletId)!.push(operation);
    if (!MoneroService.walletProcessing.get(walletId)) {
      await MoneroService.processWalletQueue(walletId);
    }
  }

  private static async processWalletQueue(walletId: string): Promise<void> {
    MoneroService.walletProcessing.set(walletId, true);
    const queue = MoneroService.walletQueues.get(walletId);

    while (queue && queue.length > 0) {
      const operation = queue.shift();
      if (operation) {
        try {
          await operation();
        } catch (error) {
          console.error(
            `[ERROR] Error processing wallet ${walletId} operation: ${error.message}`
          );
        }
      }
    }

    MoneroService.walletProcessing.set(walletId, false);
  }

  private async checkChainStatus(): Promise<void> {
    const status = await this.makeDaemonRpcCall("get_info");
    if (status?.result?.synchronized) {
      this.chainActive = true;
      console.log("Chain 'Monero' is active and synchronized.");
    } else {
      this.chainActive = false;
      console.error("Chain 'Monero' is not synchronized.");
    }
  }

  private async makeDaemonRpcCall(
    method: string,
    params: any = {}
  ): Promise<any> {
    const response = await this.makeRpcCall(this.daemonRpcUrl, method, params);
    if (response.error) {
      console.error(
        `[ERROR] Daemon RPC call failed for method ${method}: ${response.error.message}`
      );
      throw new Error(response.error.message);
    }
    return response;
  }

  private async makeWalletRpcCall(
    method: string,
    params: any = {}
  ): Promise<any> {
    return this.makeRpcCall(this.walletRpcUrl, method, params);
  }

  private async makeRpcCall(
    rpcUrl: string,
    method: string,
    params: any = {},
    retries = 3
  ): Promise<any> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "0",
      method,
      params,
    });

    const auth =
      this.rpcUser && this.rpcPassword
        ? "Basic " +
          Buffer.from(`${this.rpcUser}:${this.rpcPassword}`).toString("base64")
        : "";

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await fetch(rpcUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(auth ? { Authorization: auth } : {}),
          },
          body,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `HTTP error! status: ${response.status}, message: ${errorText}`
          );
        }

        return await response.json();
      } catch (error) {
        console.error(
          `Error in makeRpcCall attempt ${attempt + 1} to ${rpcUrl}: ${
            error.message
          }`
        );
        if (attempt === retries - 1) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait before retry
      }
    }
  }

  public async monitorMoneroDeposits(wallet: walletAttributes) {
    try {
      if (!MoneroService.monitoredWallets.has(wallet.id)) {
        MoneroService.monitoredWallets.set(wallet.id, wallet);
        console.log(`[INFO] Added wallet ${wallet.id} to monitored wallets.`);
        await MoneroService.addToWalletQueue(wallet.id, async () =>
          this.processMonitoredWallet(wallet.id)
        );
      } else {
        console.log(`[INFO] Wallet ${wallet.id} is already being monitored.`);
      }
    } catch (error) {
      console.error(
        `[ERROR] Error monitoring Monero deposits: ${error.message}`
      );
    }
  }

  /**
   * Removes the wallet from the monitored wallets map.
   */
  public async unmonitorMoneroDeposits(walletId: string) {
    if (MoneroService.monitoredWallets.has(walletId)) {
      MoneroService.monitoredWallets.delete(walletId);
      console.log(`[INFO] Removed wallet ${walletId} from monitored wallets.`);
    }
  }

  /**
   * Process the monitored wallets in the queue, opening each wallet to check for deposits.
   */
  private async processMonitoredWallet(walletId: string): Promise<void> {
    const wallet = MoneroService.monitoredWallets.get(walletId);
    if (!wallet) return;

    let retryCount = 0;
    const checkWalletForDeposits = async () => {
      try {
        await MoneroService.addToQueue(async () => {
          await this.openWallet(wallet.id);
          console.log(`[INFO] Checking deposits for wallet ${wallet.id}`);
          const transfers = await this.makeWalletRpcCall("get_transfers", {
            in: true,
            pending: true,
            account_index: 0,
          });

          if (transfers.result?.in && transfers.result.in.length > 0) {
            for (const tx of transfers.result.in) {
              if (
                tx.confirmations >= MoneroService.MIN_CONFIRMATIONS &&
                !MoneroService.processedTransactions.has(tx.txid)
              ) {
                console.log(
                  `[INFO] Found confirmed deposit for wallet ${wallet.id} with transaction ${tx.txid}`
                );
                const depositProcessed = await this.processMoneroTransaction(
                  tx.txid,
                  wallet
                );

                if (depositProcessed) {
                  await this.unmonitorMoneroDeposits(wallet.id);
                  retryCount = MoneroService.MAX_RETRIES; // Stop retrying
                }
              } else if (tx.confirmations < MoneroService.MIN_CONFIRMATIONS) {
                console.log(
                  `[INFO] Transaction ${tx.txid} for wallet ${wallet.id} has ${tx.confirmations} confirmations.`
                );
              }
            }
          } else {
            console.log(`[INFO] No deposits found for wallet ${wallet.id}`);
          }
          await this.closeWallet();
        });

        retryCount++;
        if (
          retryCount < MoneroService.MAX_RETRIES &&
          MoneroService.monitoredWallets.has(wallet.id)
        ) {
          setTimeout(checkWalletForDeposits, MoneroService.RETRY_INTERVAL);
        } else if (retryCount >= MoneroService.MAX_RETRIES) {
          console.log(
            `[INFO] Max retries reached for wallet ${wallet.id}. Removing from monitored.`
          );
          await this.unmonitorMoneroDeposits(wallet.id);
        }
      } catch (error) {
        console.error(
          `[ERROR] Error processing wallet ${wallet.id}: ${error.message}`
        );
      }
    };

    checkWalletForDeposits();
  }

  private async processMoneroTransaction(
    transactionHash: string,
    wallet: walletAttributes
  ): Promise<boolean> {
    try {
      console.log(
        `[INFO] Processing Monero transaction ${transactionHash} for wallet ${wallet.id}`
      );
      let transactionProcessed = false;

      await MoneroService.addToQueue(async () => {
        await this.openWallet(wallet.id);

        if (!MoneroService.processedTransactions.has(transactionHash)) {
          const existingTransaction = await models.transaction.findOne({
            where: { referenceId: transactionHash, status: "COMPLETED" },
          });
          if (!existingTransaction) {
            const transactionInfo = await this.makeWalletRpcCall(
              "get_transfer_by_txid",
              { txid: transactionHash }
            );
            if (transactionInfo.result && transactionInfo.result.transfer) {
              const transfer = transactionInfo.result.transfer;

              const amount = transfer.amount
                ? (transfer.amount / 1e12).toFixed(8)
                : null;
              const fee = transfer.fee
                ? (transfer.fee / 1e12).toFixed(8)
                : null;

              const addresses =
                typeof wallet.address === "string"
                  ? JSON.parse(wallet.address)
                  : wallet.address;
              const moneroAddress = addresses["XMR"].address;

              if (amount === null || fee === null) {
                throw new Error(
                  `Amount or fee is null for transaction ${transactionHash}`
                );
              }

              const txData = {
                contractType: "NATIVE",
                id: wallet.id,
                chain: "XMR",
                hash: transactionHash,
                type: "DEPOSIT",
                from: "N/A",
                address: moneroAddress,
                amount: amount,
                fee: fee,
                status: "COMPLETED",
              };

              await storeAndBroadcastTransaction(txData, transactionHash);
              MoneroService.processedTransactions.add(transactionHash);
              await this.unmonitorMoneroDeposits(wallet.id);
              transactionProcessed = true;
            } else {
              console.error(
                `[ERROR] Transaction ${transactionHash} not found on Monero blockchain.`
              );
            }
          } else {
            MoneroService.processedTransactions.add(transactionHash);
          }
        }
        await this.closeWallet();
      });
      return transactionProcessed;
    } catch (error) {
      console.error(
        `[ERROR] Error processing transaction ${transactionHash}: ${error.message}`
      );
      return false;
    }
  }

  private async openWallet(walletId: string): Promise<void> {
    try {
      const response = await this.makeWalletRpcCall("open_wallet", {
        filename: walletId,
        password: this.walletPassword || "",
      });
      if (response.error) {
        throw new Error(
          `Failed to open wallet: ${JSON.stringify(response.error)}`
        );
      }
      console.log(`Wallet ${walletId} opened successfully.`);
    } catch (error) {
      console.error(`Error opening wallet ${walletId}: ${error.message}`);
      if (error.message.includes("Failed to open wallet")) {
        console.log("Attempting to close any open wallet and retry...");
        await this.closeWallet();
        const retryResponse = await this.makeWalletRpcCall("open_wallet", {
          filename: walletId,
          password: this.walletPassword || "",
        });
        if (retryResponse.error) {
          throw new Error(
            `Failed to open wallet on retry: ${JSON.stringify(retryResponse.error)}`
          );
        }
        console.log(`Wallet ${walletId} opened successfully on retry.`);
      } else {
        throw error;
      }
    }
  }

  private async closeWallet(): Promise<void> {
    const response = await this.makeWalletRpcCall("close_wallet");
    if (response.error) {
      throw new Error(
        `Failed to close wallet: ${JSON.stringify(response.error)}`
      );
    }
    console.log("Wallet closed successfully.");
  }

  /**
   * Creates a new Monero wallet.
   */
  public async createWallet(walletName: string): Promise<WalletCreationResult> {
    return new Promise((resolve, reject) => {
      MoneroService.addToQueue(async () => {
        this.ensureChainActive();
        console.log(`Creating Monero wallet: ${walletName}`);

        try {
          // Step 1: Create the wallet
          const response = await this.makeWalletRpcCall("create_wallet", {
            filename: walletName,
            password: this.walletPassword || "",
            language: "English",
          });

          if (response.result) {
            // Log and return important wallet data such as address and mnemonic
            const walletAddress = await this.getAddress();
            const walletMnemonic = await this.getMnemonic();

            console.log(`Monero wallet created. Address: ${walletAddress}`);

            resolve({
              address: walletAddress,
              data: { mnemonic: walletMnemonic },
            });
          } else {
            throw new Error(
              `Failed to create wallet: ${JSON.stringify(response)}`
            );
          }
        } catch (error) {
          reject(error);
        } finally {
          // Ensure that the wallet is closed even if an error occurs
          await this.closeWallet();
        }
      });
    });
  }

  /**
   * Retrieves the balance of a wallet.
   */
  public async getBalance(walletName: string): Promise<string> {
    return new Promise((resolve, reject) => {
      MoneroService.addToQueue(async () => {
        this.ensureChainActive();
        console.log(`Opening wallet: ${walletName}`);

        try {
          // Open the wallet by name
          const openResponse = await this.makeWalletRpcCall("open_wallet", {
            filename: walletName,
            password: this.walletPassword || "",
          });

          // Check if wallet opened successfully
          if (openResponse.result) {
            console.log(`Wallet ${walletName} opened successfully.`);
          } else if (openResponse.error) {
            console.error(
              `Failed to open wallet: ${JSON.stringify(openResponse.error)}`
            );
            reject(
              new Error(
                `Failed to open wallet: ${JSON.stringify(openResponse.error)}`
              )
            );
            return; // Stop further execution if wallet couldn't be opened
          }

          // Add a delay to allow the wallet to fully sync
          await new Promise((resolve) => setTimeout(resolve, 2000)); // 2-second delay

          // Fetch the wallet balance
          const balanceResponse = await this.makeWalletRpcCall("get_balance", {
            account_index: 0, // Default account
          });

          console.log("Balance response:", balanceResponse);

          if (
            typeof balanceResponse.result?.balance === "number" &&
            balanceResponse.result.balance >= 0
          ) {
            // If the balance is found and it's a valid number, even 0 is acceptable
            const balanceInXMR = (
              balanceResponse.result.balance / 1e12
            ).toString();
            console.log(
              `Balance for wallet ${walletName}: ${balanceInXMR} XMR`
            );
            resolve(balanceInXMR);
          } else {
            throw new Error(
              `Failed to retrieve balance for wallet: ${walletName}`
            );
          }
        } catch (error) {
          console.error("Error fetching wallet balance:", error.message);
          reject(error);
        } finally {
          // Ensure the wallet is closed, even if there's an error
          await this.closeWallet();
        }
      });
    });
  }

  /**
   * Fetches the wallet address via wallet RPC.
   */
  private async getAddress(): Promise<string> {
    const response = await this.makeWalletRpcCall("get_address", {
      account_index: 0, // Default account
    });

    if (response.result && response.result.address) {
      return response.result.address;
    } else {
      throw new Error("Failed to retrieve Monero wallet address.");
    }
  }

  /**
   * Fetches the mnemonic for the current wallet via wallet RPC.
   */
  private async getMnemonic(): Promise<string> {
    const response = await this.makeWalletRpcCall("query_key", {
      key_type: "mnemonic",
    });

    if (response.result && response.result.key) {
      return response.result.key;
    } else {
      throw new Error("Failed to retrieve Monero wallet mnemonic.");
    }
  }

  /**
   * Ensures the chain is active.
   */
  private ensureChainActive(): void {
    if (!this.chainActive) {
      throw new Error("Chain 'Monero' is not active.");
    }
  }

  public async ensureWalletExists(walletName: string): Promise<void> {
    try {
      console.log(
        `Checking if wallet ${walletName} exists in directory ./wallets`
      );
      const openResponse = await this.makeWalletRpcCall("open_wallet", {
        filename: walletName,
        password: this.walletPassword || "",
      });

      if (
        openResponse.error &&
        openResponse.error.message.includes("Failed to open wallet")
      ) {
        console.log(`Wallet ${walletName} does not exist. Creating it.`);
        await this.createWallet(walletName);
      } else {
        console.log(`Wallet ${walletName} exists and is ready to use.`);
      }
    } catch (error) {
      logError("monero_ensure_wallet_exists", error, __filename);
      throw new Error(
        `Error ensuring wallet ${walletName} exists: ${error.message}`
      );
    }
  }

  /**
   * Fetches and parses transactions for a given Monero wallet.
   * @param walletName The Monero wallet name to fetch transactions for.
   */
  public async fetchTransactions(
    walletName: string
  ): Promise<ParsedTransaction[]> {
    try {
      // Step 1: Ensure the chain is active
      this.ensureChainActive();

      // Step 2: Open the wallet to access its transactions
      await this.openWallet(walletName);

      // Step 3: Fetch transactions using Monero's 'get_transfers' RPC call
      const response = await this.makeWalletRpcCall("get_transfers", {
        in: true, // Fetch incoming transactions
        out: true, // Fetch outgoing transactions
        pending: true, // Fetch pending transactions
        failed: true, // Fetch failed transactions
      });

      if (response.result) {
        const rawTransactions = [
          ...(response.result.in || []),
          ...(response.result.out || []),
          ...(response.result.pending || []),
          ...(response.result.failed || []),
        ];

        // Step 4: Parse raw transactions into the ParsedTransaction format
        const parsedTransactions =
          this.parseMoneroTransactions(rawTransactions);
        return parsedTransactions;
      } else {
        throw new Error(
          `Failed to retrieve transactions for wallet: ${walletName}`
        );
      }
    } catch (error) {
      logError("monero_fetch_transactions", error, __filename);
      throw new Error(`Failed to fetch Monero transactions: ${error.message}`);
    } finally {
      // Ensure the wallet is closed after fetching the transactions
      await this.closeWallet();
    }
  }

  /**
   * Parses Monero transactions into a standardized format.
   * @param rawTransactions Array of raw transaction data from Monero.
   */
  private parseMoneroTransactions(rawTransactions: any[]): ParsedTransaction[] {
    return rawTransactions.map((tx) => ({
      timestamp: new Date(tx.timestamp * 1000).toISOString(),
      hash: tx.txid,
      from: tx.type === "in" ? "N/A" : tx.address, // Monero hides sender address for incoming txs
      to: tx.type === "in" ? tx.address : "N/A", // Monero hides recipient address for outgoing txs
      amount: (tx.amount / 1e12).toFixed(8), // Convert atomic units to XMR
      confirmations: tx.confirmations.toString(),
      status: tx.confirmations > 0 ? "Success" : "Pending",
      isError: tx.failed ? "1" : "0",
      fee: (tx.fee / 1e12).toFixed(8),
    }));
  }

  /**
   * Estimates the fee for a Monero transaction.
   * @param priority Transaction priority: 0 (low), 1 (medium), 2 (high).
   */
  public async estimateMoneroFee(
    priority: number = 1 // Transaction priority: 0 (slow), 1 (normal), 2 (fast), 3 (fastest)
  ): Promise<number> {
    console.log(`[INFO] Starting fee estimation via daemon RPC`);

    try {
      // Fetch fee estimate from the daemon
      const feeEstimateResponse =
        await this.makeDaemonRpcCall("get_fee_estimate");

      // Check the status
      if (feeEstimateResponse.result?.status !== "OK") {
        throw new Error("Fee estimation RPC call did not return an OK status.");
      }

      // Extract fees array and select based on priority
      const feesArray = feeEstimateResponse.result?.fees;
      if (!feesArray || feesArray.length === 0) {
        throw new Error("No fees array received from daemon.");
      }

      // Use the priority index to select the appropriate fee, default to "normal" if out of bounds
      const feePerByte = feesArray[priority] || feesArray[1]; // Fallback to "normal" priority if needed
      const transactionSizeBytes = 2000; // Estimated average transaction size in bytes
      const estimatedFee = (feePerByte * transactionSizeBytes) / 1e12; // Convert atomic units to XMR

      console.log(
        `[INFO] Estimated fee for priority ${priority}: ${estimatedFee} XMR`
      );
      return estimatedFee;
    } catch (error) {
      console.error(`[ERROR] Fee estimation failed: ${error.message}`);
      throw new Error(`Failed to estimate Monero fee: ${error.message}`);
    }
  }

  /**
   * Handles Monero withdrawal by transferring XMR to the specified address.
   * @param transactionId Transaction ID
   * @param walletId Wallet ID
   * @param amount Amount in XMR
   * @param toAddress Recipient's Tron address
   * @param priority Transaction priority: 0 (low), 1 (medium), 2 (high)
   */
  public async handleMoneroWithdrawal(
    transactionId: string,
    walletId: string,
    amount: number,
    toAddress: string,
    priority: number = 0 // Transaction priority: 0 (low), 1 (medium), 2 (high)
  ): Promise<void> {
    return new Promise(async (resolve, reject) => {
      try {
        // Add this operation to the wallet-specific queue
        await MoneroService.addToWalletQueue(walletId, async () => {
          // Open the wallet
          const walletName = walletId;
          await this.openWallet(walletName);

          // Step 1: Check balances
          const balanceResponse = await this.makeWalletRpcCall("get_balance", {
            account_index: 0, // Default account
          });

          const totalBalance = balanceResponse.result?.balance / 1e12; // Convert to XMR
          const unlockedBalance =
            balanceResponse.result?.unlocked_balance / 1e12; // Convert to XMR

          if (totalBalance < amount) {
            // Insufficient funds, fail the transaction
            console.error(`[ERROR] Insufficient funds in wallet ${walletId}.`);
            await models.transaction.update(
              {
                status: "FAILED",
                description: "Insufficient funds.",
              },
              { where: { id: transactionId } }
            );
            throw new Error("Insufficient funds.");
          }

          if (unlockedBalance < amount) {
            // Funds are locked, requeue the transaction
            console.log(
              `[INFO] Funds locked for wallet ${walletId}. Requeuing transaction ${transactionId}.`
            );
            await models.transaction.update(
              {
                status: "PENDING",
                description: "Funds are locked. Waiting to process.",
              },
              { where: { id: transactionId } }
            );

            // Re-add the operation to the queue for later processing
            await MoneroService.addToWalletQueue(walletId, () =>
              this.handleMoneroWithdrawal(
                transactionId,
                walletId,
                amount,
                toAddress,
                priority
              )
            );
            return; // Exit current execution and wait for the queue to reprocess
          }

          // Step 2: Execute the transfer
          const transferResponse = await this.makeWalletRpcCall("transfer", {
            destinations: [
              { amount: Math.round(amount * 1e12), address: toAddress },
            ],
            priority: priority,
          });

          if (!transferResponse.result?.tx_hash) {
            throw new Error("Failed to execute Monero transaction.");
          }

          // Update the transaction as completed
          await models.transaction.update(
            {
              status: "COMPLETED",
              referenceId: transferResponse.result.tx_hash,
            },
            { where: { id: transactionId } }
          );

          console.log(
            `[SUCCESS] Withdrawal for transaction ${transactionId} completed.`
          );
        });

        resolve();
      } catch (error) {
        console.error(`Failed to execute Monero withdrawal: ${error.message}`);
        await models.transaction.update(
          {
            status: "FAILED",
            description: `Withdrawal failed: ${error.message}`,
          },
          { where: { id: transactionId } }
        );
        reject(error);
      } finally {
        await this.closeWallet(); // Ensure the wallet is closed
      }
    });
  }

  /**
   * Sends a Monero transaction (withdrawal).
   * @param walletName The wallet to send from.
   * @param destinationAddress The address to send the funds to.
   * @param amountXMR The amount of XMR to send (in XMR, not atomic units).
   */
  public async transferXMR(
    walletName: string,
    destinationAddress: string,
    amountXMR: number
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      MoneroService.addToQueue(async () => {
        this.ensureChainActive();
        console.log(`Opening wallet: ${walletName} to send transaction.`);

        try {
          // Open the wallet by name
          const openResponse = await this.makeWalletRpcCall("open_wallet", {
            filename: walletName,
            password: this.walletPassword || "",
          });

          if (openResponse.result) {
            console.log(`Wallet ${walletName} opened successfully.`);
          } else {
            throw new Error(`Failed to open wallet: ${walletName}`);
          }

          // Convert amount from XMR to atomic units
          const amountAtomic = Math.round(amountXMR * 1e12);

          // Send the transaction using the 'transfer' method
          const transferResponse = await this.makeWalletRpcCall("transfer", {
            destinations: [
              {
                amount: amountAtomic,
                address: destinationAddress,
              },
            ],
            priority: 0, // Standard priority
            account_index: 0, // Default account
          });

          if (transferResponse.result?.tx_hash) {
            console.log(
              `Transaction successful. TX hash: ${transferResponse.result.tx_hash}`
            );
            resolve(transferResponse.result.tx_hash);
          } else {
            throw new Error(
              `Failed to send transaction: ${JSON.stringify(transferResponse)}`
            );
          }
        } catch (error) {
          console.error("Error sending transaction:", error.message);
          reject(error);
        } finally {
          // Ensure the wallet is closed after the transaction
          await this.closeWallet();
        }
      });
    });
  }
}

export default MoneroService;
