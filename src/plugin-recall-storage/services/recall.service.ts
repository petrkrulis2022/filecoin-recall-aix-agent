import {
  RecallClient,
  testnet,
  walletClientFromPrivateKey,
  CreditAccount,
  BuyResult,
} from "../../../../js-recall/packages/sdk/dist/index.js"; // to replace with import from recall-sdk
import { elizaLogger, UUID, Service, ServiceType } from "@elizaos/core";
import { parseEther } from "viem";
import { ICotAgentRuntime } from "../../types/index.js";

type Address = `0x${string}`;
type AccountInfo = {
  address: Address;
  nonce: number;
  balance: bigint;
  parentBalance?: bigint;
};

const privateKey = process.env.RECALL_PRIVATE_KEY as `0x${string}`;


export class RecallService extends Service {
  static serviceType: ServiceType = "recall" as ServiceType;
  private client: RecallClient;
  private runtime: ICotAgentRuntime;
  private syncInterval: NodeJS.Timeout | undefined;

  getInstance(): RecallService {
    return RecallService.getInstance();
  }

  async initialize(_runtime: ICotAgentRuntime): Promise<void> {
    try {
      if (!process.env.RECALL_PRIVATE_KEY) {
        throw new Error("RECALL_PRIVATE_KEY is required");
      }
      const wallet = walletClientFromPrivateKey(privateKey, testnet);
      this.client = new RecallClient({ walletClient: wallet });
      this.runtime = _runtime;
      await this.startPeriodicSync();
      elizaLogger.success("RecallService initialized successfully, starting periodic sync.");
    } catch (error) {
      elizaLogger.error(`Error initializing RecallService: ${error.message}`);
    }
  }

  /**
   * Gets the account information for the current user.
   * @returns The account information.
   */

  public async getAccountInfo(): Promise<AccountInfo> | undefined {
    try {
      const info = await this.client.accountManager().info();
      return info.result;
    } catch (error) {
      elizaLogger.error(`Error getting account info: ${error.message}`);
      throw error;
    }
  }

  /**
   * Gets the credit information for the account.
   * @returns The credit information.
   */

  public async getCreditInfo(): Promise<CreditAccount> | undefined {
    try {
      const info = await this.client.creditManager().getAccount();
      return info.result;
    } catch (error) {
      elizaLogger.error(`Error getting credit info: ${error.message}`);
      throw error;
    }
  }

  /**
   * Buys credit for the account.
   * @param amount The amount of credit to buy.
   * @returns The result of the buy operation.
   */

  public async buyCredit(amount: string): Promise<BuyResult> | undefined {
    try {
      const info = await this.client.creditManager().buy(parseEther(amount));
      return info.result;
    } catch (error) {
      elizaLogger.error(`Error buying credit: ${error.message}`);
      throw error;
    }
  }

  /**
   * Gets or creates a log bucket in Recall.
   * @param bucketAlias The alias of the bucket to retrieve or create.
   * @returns The address of the log bucket.
   */

  public async getOrCreateLogBucket(bucketAlias: string): Promise<Address> {
    try {
      // Try to find the bucket by alias
      const buckets = await this.client.bucketManager().list();
      if (buckets?.result) {
        const bucket = buckets.result.find(
          (b) => b.metadata?.alias === bucketAlias
        );
        if (bucket) {
          return bucket.addr; // Return existing bucket address
        } else {
          elizaLogger.info(
            `Bucket with alias ${bucketAlias} not found, creating a new one.`
          );
        }
      }

      // If not found, create a new bucket with the same alias
      const query = await this.client.bucketManager().create({ metadata: { alias: bucketAlias } });
      const newBucket = query.result;
      if (!newBucket) {
        elizaLogger.error(
          `Failed to create new bucket with alias: ${bucketAlias}`
        );
      }

      elizaLogger.info(`Created new log bucket with alias: ${bucketAlias}`);
      return newBucket.bucket;
    } catch (error) {
      elizaLogger.error(
        `Error getting or creating log bucket: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Stores a batch of logs to Recall.
   * @param bucketAddress The address of the bucket to store logs.
   * @param batch The batch of logs to store.
   * @returns The key under which the logs were stored.
   */

  async storeBatchToRecall(bucketAddress: Address, batch: string[]): Promise<string | undefined> {
    try {
      // Query existing log keys to determine the next log file index
      // Generate a unique filename using timestamp instead of an incrementing index
      const timestamp = Date.now();
      const nextLogKey = `cot/${timestamp}.jsonl`;

      // Join batch into a single JSONL file
      const batchData = batch.join("\n");

      const addObject = await this.client.bucketManager().add(bucketAddress, nextLogKey, new TextEncoder().encode(batchData));
      // Store in Recall
      const result = addObject.result;

      if (result) {
        elizaLogger.info(`Batched JSONL logs stored under key: ${nextLogKey}`);
        return nextLogKey;
      }
    } catch (error) {
      elizaLogger.error(`Error storing JSONL logs in Recall: ${error.message}`);
    }
    return undefined;
  }

  /**
   * Syncs logs to Recall in batches.
   * @param bucketAlias The alias of the bucket to store logs.
   * @param batchSizeKB The maximum size of each batch in kilobytes.
   */

  async syncLogsToRecall(bucketAlias: string, batchSizeKB = 4): Promise<void> {
    try {
      const bucketAddress = await this.getOrCreateLogBucket(bucketAlias);

      // Fetch unsynced logs from SQLite
      const unsyncedLogs = await this.runtime.databaseAdapter.getUnsyncedLogs();
      // filter unsynced logs by "chain-of-thought" type
      const filteredLogs = unsyncedLogs.filter((log) => log.type === "chain-of-thought");
      if (filteredLogs.length === 0) {
        elizaLogger.info("No unsynced logs to process.");
        return;
      } else {
        elizaLogger.info(`Found ${filteredLogs.length} unsynced logs.`);
      }

      let batch: string[] = [];
      let batchSize = 0; // in bytes
      let syncedLogIds: UUID[] = [];

      for (const log of filteredLogs) {
        try {
          // Parse JSON stored in body
          const parsedLog = JSON.parse(log.body);
          const jsonlEntry = JSON.stringify({
            userId: parsedLog.userId,
            agentId: parsedLog.agentId,
            userMessage: parsedLog.userMessage,
            log: parsedLog.log,
          });

          const logSize = new TextEncoder().encode(jsonlEntry).length; // Get byte size
          elizaLogger.info(`Processing log entry of size: ${logSize} bytes`);

          if (batchSize + logSize > batchSizeKB * 1024) {
            elizaLogger.info(`Batch size currently ${batchSize + logSize} bytes, exceeding limit of ${batchSizeKB} KB. Syncing batch...`);
            // Sync current batch
            const logFileKey = await this.storeBatchToRecall(bucketAddress, batch);
            if (logFileKey) {
              await this.runtime.databaseAdapter.markLogsAsSynced(syncedLogIds);
            }
            // Reset batch
            batch = [];
            batchSize = 0;
            syncedLogIds = [];
          } else {
            elizaLogger.info(`Current batch size is ${batchSize + logSize} bytes, within the limit of ${batchSizeKB} KB. Not syncing yet.`);
          }

          batch.push(jsonlEntry);
          batchSize += logSize;
          syncedLogIds.push(log.id);
        } catch (error) {
          elizaLogger.error(`Error parsing log entry: ${error.message}`);
        }
      }

      elizaLogger.success("All unsynced logs successfully synced to Recall.");
    } catch (error) {
      elizaLogger.error(`Error syncing logs to Recall: ${error.message}`);
      throw error;
    }
  }

  /**
   * Retrieve and order all chain-of-thought logs from Recall.
   * @param bucketAlias The alias of the bucket to query.
   * @returns An array of ordered chain-of-thought logs.
   */

  async retrieveOrderedChainOfThoughtLogs(bucketAlias: string): Promise<any[]> {
    try {
      const bucketAddress = await this.getOrCreateLogBucket(bucketAlias);

      // Query all objects with "cot/" prefix
      const queryResult = await this.client.bucketManager().query(bucketAddress, { prefix: "cot/" });
      if (!queryResult.result?.objects.length) {
        elizaLogger.info(`No chain-of-thought logs found in bucket: ${bucketAlias}`);
        return [];
      }

      // Extract log filenames and sort by timestamp
      const logFiles = queryResult.result.objects
        .map(obj => obj.key)
        .filter(key => key.match(/^cot\/\d+\.jsonl$/)) // Ensure correct format
        .sort((a, b) => {
          // Extract timestamps and sort numerically
          const timeA = parseInt(a.match(/^cot\/(\d+)\.jsonl$/)?.[1] || "0", 10);
          const timeB = parseInt(b.match(/^cot\/(\d+)\.jsonl$/)?.[1] || "0", 10);
          return timeA - timeB;
        });

      elizaLogger.info(`Retrieving ${logFiles.length} ordered chain-of-thought logs...`);

      let allLogs: any[] = [];

      // Download and parse each log file
      for (const logFile of logFiles) {
        try {
          const logData = await this.client.bucketManager().get(bucketAddress, logFile);
          if (!logData.result) continue;

          // Decode and split JSONL content
          const decodedLogs = new TextDecoder().decode(logData.result).trim().split("\n");
          const parsedLogs = decodedLogs.map(line => JSON.parse(line));


          allLogs.push(...parsedLogs);
        } catch (error) {
          elizaLogger.error(`Error retrieving log file ${logFile}: ${error.message}`);
        }
      }
      elizaLogger.info(`Successfully retrieved and ordered ${allLogs.length} chain-of-thought logs.`);
      return allLogs;
    } catch (error) {
      elizaLogger.error(`Error retrieving ordered chain-of-thought logs: ${error.message}`);
      throw error;
    }
  }


  /**
    * Starts the periodic log syncing.
    * @param intervalMs The interval in milliseconds for syncing logs.
    */

  public startPeriodicSync(intervalMs = 2 * 60 * 1000): void {
    if (this.syncInterval) {
      elizaLogger.warn("Log sync is already running.");
      return;
    }

    elizaLogger.info("Starting periodic log sync...");
    this.syncInterval = setInterval(async () => {
      try {
        await this.syncLogsToRecall("cot-new");
      } catch (error) {
        elizaLogger.error(`Periodic log sync failed: ${error.message}`);
      }
    }, intervalMs);

    // Perform an immediate sync on startup
    this.syncLogsToRecall("cot-new").catch(error =>
      elizaLogger.error(`Initial log sync failed: ${error.message}`)
    );
  }

  /**
   * Stops the periodic log syncing.
   */
  public stopPeriodicSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = undefined;
      elizaLogger.info("Stopped periodic log syncing.");
    }
  }

}

