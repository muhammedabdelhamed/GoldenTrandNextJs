import { models } from "@b/db";
import { handleUTXOWithdrawal } from "@b/utils/eco/utxo";
import { handleNotification } from "@b/utils/notifications";
import SolanaService from "@b/blockchains/sol";
import { refundUser } from "@b/utils/eco/wallet";
import { emailQueue } from "@b/utils/emails";
import { handleEvmWithdrawal } from "./withdraw";
import TronService from "@b/blockchains/tron";
import MoneroService from "@b/blockchains/xmr";
import TonService from "@b/blockchains/ton";

class WithdrawalQueue {
  private static instance: WithdrawalQueue;
  private queue: string[] = [];
  private isProcessing: boolean = false;
  private processingTransactions: Set<string> = new Set();

  private constructor() {}

  public static getInstance(): WithdrawalQueue {
    if (!WithdrawalQueue.instance) {
      WithdrawalQueue.instance = new WithdrawalQueue();
    }
    return WithdrawalQueue.instance;
  }

  public addTransaction(transactionId: string) {
    if (this.processingTransactions.has(transactionId)) {
      // Transaction is already being processed
      return;
    }
    if (!this.queue.includes(transactionId)) {
      this.queue.push(transactionId);
      this.processNext();
    }
  }

  private async processNext() {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const transactionId = this.queue.shift();

    if (transactionId) {
      try {
        this.processingTransactions.add(transactionId);

        // Fetch the transaction from the database
        const transaction = await models.transaction.findOne({
          where: { id: transactionId },
          include: [
            {
              model: models.wallet,
              as: "wallet",
              where: { type: "ECO" },
            },
          ],
        });

        if (!transaction) {
          console.error(`Transaction ${transactionId} not found.`);
          throw new Error("Transaction not found");
        }

        if (!transaction.wallet) {
          console.error(`Wallet not found for transaction ${transactionId}`);
          throw new Error("Wallet not found for transaction");
        }

        // Update transaction status to 'PROCESSING' to prevent duplicate processing
        const [updatedCount] = await models.transaction.update(
          { status: "PROCESSING" },
          { where: { id: transactionId, status: "PENDING" } }
        );

        if (updatedCount === 0) {
          throw new Error("Transaction already processed or in process");
        }

        const metadata =
          typeof transaction.metadata === "string"
            ? JSON.parse(transaction.metadata)
            : transaction.metadata;

        if (!metadata || !metadata.chain) {
          throw new Error("Invalid or missing chain in transaction metadata");
        }

        // Process withdrawal based on the blockchain chain type
        await this.processWithdrawal(transaction, metadata);

        // Send email to the user
        await this.sendWithdrawalConfirmationEmail(transaction, metadata);

        // Record admin profit if a fee is associated with the transaction
        await this.recordAdminProfit(transaction, metadata);
      } catch (error) {
        console.error(
          `Failed to process transaction ${transactionId}: ${error.message}`
        );

        // Mark transaction as 'FAILED' and attempt to refund the user
        await this.markTransactionFailed(transactionId, error.message);

        await new Promise((resolve) => setTimeout(resolve, 1000));
      } finally {
        this.processingTransactions.delete(transactionId);
        this.isProcessing = false;
        setImmediate(() => this.processNext()); // Process the next transaction
      }
    } else {
      this.isProcessing = false;
    }
  }

  private async processWithdrawal(transaction: any, metadata: any) {
    if (["BTC", "LTC", "DOGE", "DASH"].includes(metadata.chain)) {
      await handleUTXOWithdrawal(transaction);
    } else if (metadata.chain === "SOL") {
      const solanaService = await SolanaService.getInstance();
      if (metadata.contractType === "PERMIT") {
        await solanaService.handleSplTokenWithdrawal(
          transaction.id,
          transaction.walletId,
          metadata.contract,
          transaction.amount,
          metadata.toAddress,
          metadata.decimals
        );
      } else {
        await solanaService.handleSolanaWithdrawal(
          transaction.id,
          transaction.walletId,
          transaction.amount,
          metadata.toAddress
        );
      }
    } else if (metadata.chain === "TRON") {
      const tronService = await TronService.getInstance();
      await tronService.handleTronWithdrawal(
        transaction.id,
        transaction.walletId,
        transaction.amount,
        metadata.toAddress
      );
    } else if (metadata.chain === "XMR") {
      const moneroService = await MoneroService.getInstance();
      await moneroService.handleMoneroWithdrawal(
        transaction.id,
        transaction.walletId,
        transaction.amount,
        metadata.toAddress
      );
    } else if (metadata.chain === "TON") {
      const tonService = await TonService.getInstance();

      await tonService.handleTonWithdrawal(
        transaction.id,
        transaction.walletId,
        transaction.amount,
        metadata.toAddress
      );
    } else {
      await handleEvmWithdrawal(
        transaction.id,
        transaction.walletId,
        metadata.chain,
        transaction.amount,
        metadata.toAddress
      );
    }

    // Mark the transaction as completed after successful processing
    await models.transaction.update(
      { status: "COMPLETED" },
      { where: { id: transaction.id } }
    );
  }

  private async sendWithdrawalConfirmationEmail(
    transaction: any,
    metadata: any
  ) {
    const user = await models.user.findOne({
      where: { id: transaction.userId },
    });
    if (user) {
      const wallet = await models.wallet.findOne({
        where: {
          userId: user.id,
          currency: transaction.wallet.currency,
          type: "ECO",
        },
      });
      if (wallet) {
        await sendEcoWithdrawalConfirmationEmail(
          user,
          transaction,
          wallet,
          metadata.toAddress,
          metadata.chain
        );
      }
    }
  }

  private async recordAdminProfit(transaction: any, metadata: any) {
    if (
      transaction &&
      typeof transaction.fee === "number" &&
      transaction.fee > 0
    ) {
      await models.adminProfit.create({
        amount: transaction.fee,
        currency: transaction.wallet.currency,
        chain: metadata.chain,
        type: "WITHDRAW",
        transactionId: transaction.id,
        description: `Admin profit from withdrawal fee of ${transaction.fee} ${transaction.wallet.currency} for transaction (${transaction.id})`,
      });
    }
  }

  private async markTransactionFailed(
    transactionId: string,
    errorMessage: string
  ) {
    await models.transaction.update(
      {
        status: "FAILED",
        description: `Transaction failed: ${errorMessage}`,
      },
      { where: { id: transactionId } }
    );

    const transaction = await models.transaction.findByPk(transactionId, {
      include: [{ model: models.wallet, as: "wallet", where: { type: "ECO" } }],
    });

    if (transaction && transaction.wallet) {
      await refundUser(transaction);

      const user = await models.user.findOne({
        where: { id: transaction.userId },
      });
      if (user) {
        const metadata =
          typeof transaction.metadata === "string"
            ? JSON.parse(transaction.metadata)
            : transaction.metadata;

        await sendEcoWithdrawalFailedEmail(
          user,
          transaction,
          transaction.wallet,
          metadata.toAddress,
          errorMessage
        );
      }

      // Optionally, notify the user about the failed withdrawal
      await handleNotification({
        userId: transaction.userId,
        title: "Withdrawal Failed",
        message: `Your withdrawal of ${transaction.amount} ${transaction.wallet.currency} has failed.`,
        type: "ACTIVITY",
      });
    }
  }
}

// Email sending functions
export async function sendEcoWithdrawalConfirmationEmail(
  user: any,
  transaction: any,
  wallet: any,
  toAddress: string,
  chain: string
) {
  const emailType = "EcoWithdrawalConfirmation";
  const emailData = {
    TO: user.email,
    FIRSTNAME: user.firstName,
    AMOUNT: transaction.amount.toString(),
    CURRENCY: wallet.currency,
    TO_ADDRESS: toAddress,
    TRANSACTION_ID: transaction.referenceId || transaction.id,
    CHAIN: chain,
  };

  await emailQueue.add({ emailData, emailType });
}

export async function sendEcoWithdrawalFailedEmail(
  user: any,
  transaction: any,
  wallet: any,
  toAddress: string,
  reason: string
) {
  const emailType = "EcoWithdrawalFailed";
  const emailData = {
    TO: user.email,
    FIRSTNAME: user.firstName,
    AMOUNT: transaction.amount.toString(),
    CURRENCY: wallet.currency,
    TO_ADDRESS: toAddress,
    REASON: reason,
  };

  await emailQueue.add({ emailData, emailType });
}

export default WithdrawalQueue;
