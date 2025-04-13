import { AutoClientInterface } from '@elizaos/client-auto';
import { DiscordClientInterface } from '@elizaos/client-discord';
import { TelegramClientInterface } from '@elizaos/client-telegram';
import { Character, IAgentRuntime } from '@elizaos/core';

export async function initializeClients(character: Character, runtime: IAgentRuntime) {
  const clients = [];
  const clientTypes = character.clients?.map((str) => str.toLowerCase()) || [];
  const compatibleRuntime = runtime as any;
  if (clientTypes.includes('auto')) {
    const autoClient = await AutoClientInterface.start(compatibleRuntime);
    if (autoClient) clients.push(autoClient);
  }

  if (clientTypes.includes('discord')) {
    clients.push(await DiscordClientInterface.start(compatibleRuntime));
  }

  if (clientTypes.includes('telegram')) {
    const telegramClient = await TelegramClientInterface.start(compatibleRuntime);
    if (telegramClient) clients.push(telegramClient);
  }

  if (character.plugins?.length > 0) {
    for (const plugin of character.plugins) {
      if (plugin.clients) {
        for (const client of plugin.clients) {
          clients.push(await client.start(runtime));
        }
      }
    }
  }

  return clients;
}
