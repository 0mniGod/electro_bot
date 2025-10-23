// ----- КОД "ПІСЛЯ" (З onModuleInit ТА try...catch) -----
import {
  ElectricityAvailabilityService,
} from '@electrobot/electricity-availability';
import { UserRepository } from '@electrobot/user-repo';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common'; // <-- Додано OnModuleInit
import {
  addMinutes,
  addMonths,
  differenceInMinutes,
  format,
  formatDistance,
  getMonth,
} from 'date-fns';
import { convertToTimeZone } from 'date-fns-timezone';
import { uk } from 'date-fns/locale';
import * as TelegramBot from 'node-telegram-bot-api';
import { Bot, Place } from '@electrobot/domain';
import { PlaceRepository } from '@electrobot/place-repo';
import {
  // ... (всі ваші RESP_ константи залишаються тут) ...
   EMOJ_BULB,
   EMOJ_KISS,
   EMOJ_KISS_HEART,
   EMOJ_MOON,
   MSG_DISABLED_REGULAR_SUFFIX,
   RESP_ABOUT,
   RESP_CURRENTLY_AVAILABLE,
   RESP_CURRENTLY_UNAVAILABLE,
   RESP_DISABLED_DETAILED,
   RESP_DISABLED_SHORT,
   RESP_DISABLED_SUSPICIOUS,
   RESP_ENABLED_DETAILED,
   RESP_ENABLED_SHORT,
   RESP_PREVIOUS_MONTH_SUMMARY,
   RESP_NO_CURRENT_INFO,
   RESP_START,
   RESP_SUBSCRIPTION_ALREADY_EXISTS,
   RESP_SUBSCRIPTION_CREATED,
   RESP_UNSUBSCRIBED,
   RESP_WAS_NOT_SUBSCRIBED,
   RESP_ENABLED_SUSPICIOUS,
   MSG_DISABLED,
} from './messages.constant';

const MIN_SUSPICIOUS_DISABLE_TIME_IN_MINUTES = 30;
const BULK_NOTIFICATION_DELAY_IN_MS = 50;

@Injectable()
// Додаємо implements OnModuleInit
export class NotificationBotService implements OnModuleInit {
  private readonly logger = new Logger(NotificationBotService.name);
  private places: Record<string, Place> = {};
  private placeBots: Record<
    string,
    {
      readonly bot: Bot;
      readonly telegramBot: TelegramBot;
    }
  > = {};
  private isRefreshingPlacesAndBots = false;

  constructor(
    private readonly electricityAvailabilityService: ElectricityAvailabilityService,
    private readonly userRepository: UserRepository,
    private readonly placeRepository: PlaceRepository
  ) {
    // Ми НЕ викликаємо refreshAllPlacesAndBots тут напряму

    this.electricityAvailabilityService.availabilityChange$.subscribe(
      ({ placeId }) => {
        this.notifyAllPlaceSubscribersAboutElectricityAvailabilityChange({
          placeId,
        });
      }
    );
  }

  // Цей метод буде викликано автоматично після ініціалізації модуля
  async onModuleInit(): Promise<void> {
    this.logger.log('onModuleInit called. Starting initial refresh...');
    await this.refreshAllPlacesAndBots(); // Чекаємо завершення першого оновлення

    // Запускаємо періодичне оновлення ТІЛЬКИ ПІСЛЯ першого успішного
    const refreshRate = 10 * 60 * 1000; // 10 min
    setInterval(() => this.refreshAllPlacesAndBots(), refreshRate);
    this.logger.log(`Periodic refresh scheduled every ${refreshRate / 1000 / 60} minutes.`);
  }

  // --- Залишаємо інші методи без змін ---
  public async notifyAllPlacesAboutPreviousMonthStats(): Promise<void> { /* ... код ... */ }
  private async handleStartCommand(params: { /* ... */ }): Promise<void> { /* ... код ... */ }
  private async handleCurrentCommand(params: { /* ... */ }): Promise<void> { /* ... код ... */ }
  private async handleSubscribeCommand(params: { /* ... */ }): Promise<void> { /* ... код ... */ }
  private async handleUnsubscribeCommand(params: { /* ... */ }): Promise<void> { /* ... код ... */ }
  private async handleStatsCommand(params: { /* ... */ }): Promise<void> { /* ... код ... */ }
  private async composePlaceMonthStatsMessage(params: { /* ... */ }): Promise<string> { /* ... код ... */ }
  private async handleAboutCommand(params: { /* ... */ }): Promise<void> { /* ... код ... */ }
  private async notifyAllPlaceSubscribersAboutElectricityAvailabilityChange(params: { /* ... */ }): Promise<void> { /* ... код ... */ }
  private async notifyAllPlaceSubscribersAboutPreviousMonthStats(params: { /* ... */ }): Promise<void> { /* ... код ... */ }
  private async notifyAllPlaceSubscribers(params: { /* ... */ }): Promise<void> { /* ... код ... */ }
  private isGroup(params: { readonly chatId: number }): boolean { /* ... код ... */ }
  // ------------------------------------------


  private async refreshAllPlacesAndBots(): Promise<void> {
    if (this.isRefreshingPlacesAndBots) {
      this.logger.warn('Refresh already in progress, skipping.');
      return;
    }

    this.logger.log('Starting refreshAllPlacesAndBots...');
    this.isRefreshingPlacesAndBots = true;
    try {
      const places = await this.placeRepository.getAllPlaces();
      this.logger.log(`Loaded ${places.length} places from DB.`); // Додано лог

      this.places = places.reduce<Record<string, Place>>(
        (res, place) => ({
          ...res,
          [place.id]: place,
        }),
        {}
      );

      const placeBots = await this.placeRepository.getAllPlaceBots();
      this.logger.log(`Loaded ${placeBots.length} bots configurations from DB.`); // Додано лог

      // Створюємо нові екземпляри ботів
      const newPlaceBots: typeof this.placeBots = {};
      for (const botConfig of placeBots) { // Використовуємо for...of для async/await всередині
        if (!botConfig.isEnabled) {
          this.logger.log(`Bot for place ${botConfig.placeId} is disabled, skipping creation.`);
          continue;
        }

        const place = this.places[botConfig.placeId];
        if (!place) {
          this.logger.error(
            `Place ${botConfig.placeId} not found in memory cache for bot ${botConfig.botName} - cannot create notification bot`
          );
          continue;
        }

        // Перевіряємо, чи бот вже існує, щоб не створювати заново
        let existingBotInstance = this.placeBots[botConfig.placeId]?.telegramBot;

        if (existingBotInstance) {
           // Якщо бот вже є, просто оновлюємо конфігурацію
           newPlaceBots[botConfig.placeId] = {
               bot: botConfig,
               telegramBot: existingBotInstance
           };
           this.logger.log(`Bot instance for place ${place.id} already exists, updated config.`);
        } else {
           // Якщо бота немає, створюємо новий
           try {
              const createdInstance = this.createBot({ place, bot: botConfig });
              if (createdInstance) {
                 newPlaceBots[botConfig.placeId] = {
                     bot: botConfig,
                     telegramBot: createdInstance
                 };
              }
           } catch (e) {
              this.logger.error(`Failed to create bot instance for place ${place.id}: ${e}`);
           }
        }
      }
      // Оновлюємо кеш ботів
      this.placeBots = newPlaceBots;
      this.logger.log(`Finished refreshing bots. Active instances: ${Object.keys(this.placeBots).length}`);

    } catch (e) {
      this.logger.error(`Error during refreshAllPlacesAndBots: ${e}`, e instanceof Error ? e.stack : undefined);
    } finally {
      this.isRefreshingPlacesAndBots = false;
      this.logger.log('refreshAllPlacesAndBots finished.');
    }
  }

  // Змінено: createBot тепер повертає створений екземпляр або null/undefined
  private createBot(params: {
    readonly place: Place;
    readonly bot: Bot;
  }): TelegramBot | undefined { // <-- Змінено тип повернення
    const { place, bot } = params;
    try {
      this.logger.log(`Attempting to create bot instance for place ${place.id} (${place.name}) with token starting: ${bot.token.substring(0, 10)}...`);
      const telegramBot = new TelegramBot(bot.token); // Без polling: true

      // Обробники подій залишаються тут
      telegramBot.on('polling_error', (error) => { // Обробник все ще корисний для діагностики
         this.logger.error(`${place.name}/${bot.botName} internal error (polling_error should not happen with webhooks): ${error}`);
      });
      telegramBot.onText(/\/start/, (msg) => this.handleStartCommand({ msg, place, bot, telegramBot }));
      telegramBot.onText(/\/current/, (msg) => this.handleCurrentCommand({ msg, place, bot, telegramBot }));
      telegramBot.onText(/\/subscribe/, (msg) => this.handleSubscribeCommand({ msg, place, bot, telegramBot }));
      telegramBot.onText(/\/unsubscribe/, (msg) => this.handleUnsubscribeCommand({ msg, place, bot, telegramBot }));
      telegramBot.onText(/\/stop/, (msg) => this.handleUnsubscribeCommand({ msg, place, bot, telegramBot }));
      telegramBot.onText(/\/stats/, (msg) => this.handleStatsCommand({ msg, place, bot, telegramBot }));
      telegramBot.onText(/\/about/, (msg) => this.handleAboutCommand({ msg, place, bot, telegramBot }));

      this.logger.log(`Successfully created bot instance for place ${place.id}.`);
      return telegramBot; // Повертаємо створений екземпляр

    } catch (error) {
       this.logger.error(`Failed during new TelegramBot() for place ${place.id}: ${error}`);
       return undefined; // Повертаємо undefined у разі помилки
    }
  }


  // Метод для отримання інстансу бота (залишаємо без змін)
  public getMainTelegramBotInstance(): TelegramBot | undefined {
     this.logger.log(`getMainTelegramBotInstance called. Current this.placeBots keys: ${JSON.stringify(Object.keys(this.placeBots))}`);
     const activeBotEntry = Object.values(this.placeBots).find(entry => entry.bot.isEnabled);
     if (activeBotEntry) {
       return activeBotEntry.telegramBot;
     } else {
       this.logger.warn('No active bot instance found in getMainTelegramBotInstance');
       return undefined;
     }
  }

  private async notifyBotDisabled(params: { /* ... */ }): Promise<void> { /* ... код ... */ }
  private async sleep(params: { readonly ms: number }): Promise<void> { /* ... код ... */ }
}
