import { Place } from '@electrobot/domain';
import { PlaceRepository } from '@electrobot/place-repo';
import { HttpService } from '@nestjs/axios';
// Додаємо OnModuleInit, forwardRef, Inject
import { Injectable, Logger, OnModuleInit, forwardRef, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule'; 
import {
  addHours,
  addMinutes, 
  addMonths,
  differenceInMinutes,
  eachDayOfInterval,
  endOfDay,
  endOfMonth,
  format,
  formatDistance, 
  getDay,
  getMonth, 
  startOfDay,
  startOfMonth,
  subMinutes,
} from 'date-fns';
import { convertToTimeZone } from 'date-fns-timezone';
import { uk } from 'date-fns/locale';
import { firstValueFrom, Subject, timer, zip } from 'rxjs';
import {
  distinctUntilChanged,
  filter,
  map,
  switchMap,
} from 'rxjs/operators';
import { HistoryItem } from './history-item.type';
import { ElectricityRepository } from './electricity.repository'; 
import * as net from 'net'; 
import { NotificationBotService } from '@electrobot/bot'; // <-- Додано імпорт

const CHECK_INTERVAL_IN_MINUTES = 2; // Інтервал для потоку
const API_KEY = 'demo'; // Використовуємо демонстраційний ключ

@Injectable()
export class ElectricityAvailabilityService implements OnModuleInit { // Додано OnModuleInit
  private readonly logger = new Logger(
    ElectricityAvailabilityService.name
  );
  private readonly place$ = new Subject<Place>();
  private readonly forceCheck$ = new Subject<Place>();

  // --- ДОДАНО ЗАМОК (LOCK) ---
  private static isCronRunning = false; 
  // ---------------------------

  public readonly availabilityChange$ = zip(
    this.place$,
    timer(0, CHECK_INTERVAL_IN_MINUTES * 60 * 1000) // Повертаємо числовий інтервал
  ).pipe(
    map(([place]) => place),
    filter((place) => place && !place.isDisabled),
    switchMap((place) => this.checkWithRetries(place)), // Викликаємо checkWithRetries
    distinctUntilChanged((prev, curr) => prev.isAvailable === curr.isAvailable),
    map(({ place, isAvailable }) => {
      this.handleAvailabilityChange({ place, isAvailable });
      return { placeId: place.id };
    })
  );

  constructor(
    private readonly electricityRepository: ElectricityRepository,
    private readonly placeRepository: PlaceRepository,
    private readonly httpService: HttpService,
    // Використовуємо forwardRef для уникнення циклічної залежності
    @Inject(forwardRef(() => NotificationBotService)) 
    private readonly notificationBotService: NotificationBotService
  ) {
    this.availabilityChange$.subscribe(
        (data) => {
            this.logger.debug(`Availability change processed for placeId: ${data.placeId}`);
        },
        (error) => {
            this.logger.error(`Error in availabilityChange$ stream: ${error}`, error instanceof Error ? error.stack : undefined);
        }
    );
  }

  // --- ДОДАНО onModuleInit ---
  async onModuleInit(): Promise<void> {
    this.logger.log('>>> [ElAvailSvc] ENTERING onModuleInit()');
    try {
      // Запускаємо періодичне оновлення
      const refreshRate = 10 * 60 * 1000; // 10 min
      if (!(global as any).botRefreshInterval) {
         (global as any).botRefreshInterval = setInterval(() => {
             this.logger.log('>>> [ElAvailSvc] Interval triggered: calling refreshAllPlacesAndBots()');
             this.placeRepository.getAllPlaces().then(places => { // Отримуємо актуальні 'places'
                 places.forEach(place => {
                     if (place && !place.isDisabled) {
                         this.place$.next(place); // Пушимо кожне місце в потік
                     }
                 });
             }).catch(err => {
                 this.logger.error(`Error during scheduled place refresh: ${err}`, err instanceof Error ? err.stack : undefined);
             });
         }, refreshRate);
         this.logger.log(`[ElAvailSvc] Periodic refresh scheduled every ${refreshRate / 1000 / 60} minutes.`);
      } else {
         this.logger.warn('[ElAvailSvc] Periodic refresh interval already set.');
      }
    } catch (error) {
      this.logger.error(`>>> [ElAvailSvc] CRITICAL ERROR inside onModuleInit: ${error}`, error instanceof Error ? error.stack : undefined);
    }
    this.logger.log('>>> [ElAvailSvc] EXITING onModuleInit()');
  }
  // ------------------------------------

  // --- НОВИЙ ДОПОМІЖНИЙ МЕТОД ---
  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // --- НОВИЙ МЕТОД З ПОВТОРНИМИ СПРОБАМИ (5) ---
  private async checkWithRetries(place: Place): Promise<{
    readonly place: Place;
    readonly isAvailable: boolean;
  }> {
    const retries = 5; // <-- 5 СПРОБ
    const delay = 5000; // 5 секунд між спробами

    for (let i = 1; i <= retries; i++) {
      this.logger.verbose(`Check attempt ${i}/${retries} for ${place.host}`);
      // Викликаємо check (який робить 1 спробу)
      const { isAvailable } = await this.check(place);

      if (isAvailable) {
        // Успіх
        return { place, isAvailable: true };
      }

      if (i < retries) {
        this.logger.warn(`Check attempt ${i} failed. Retrying in ${delay / 1000}s...`);
        await this.sleep(delay);
      }
    }

    // Якщо всі 5 спроб не вдалися
    this.logger.warn(`All ${retries} check attempts failed for ${place.host}. Reporting as UNAVAILABLE.`);
    return { place, isAvailable: false };
  }
  // --- КІНЕЦЬ НОВИХ МЕТОДІВ ---


  // --- ОНОВЛЕНИЙ МЕТОД CHECK (використовує ViewDNS API) ---
  private async check(place: Place): Promise<{
    readonly place: Place;
    readonly isAvailable: boolean;
  }> {
    const host = place.host;
    const url = `https://api.viewdns.info/ping/v2/?host=${host}&apikey=${API_KEY}&output=json`;

    this.logger.verbose(`Starting PING check for ${host} via ViewDNS API...`);
    let isAvailable = false; 

    try {
        const response = await firstValueFrom(
            this.httpService.get(url, { 
                timeout: 15000, 
                headers: { 'User-Agent': 'Koyeb Electro Bot Check' } 
            })
        );

        if (response.data && response.data.response && response.data.response.detail) {
            const europeRegion = response.data.response.detail.find(
                (region: any) => region.region === 'Europe'
            );

            if (europeRegion && europeRegion.locations && europeRegion.locations.length > 0) {
                const isAnyEuropeLocationOK = europeRegion.locations.some(
                    (loc: any) => loc.packet_loss === '0%'
                );

                if (isAnyEuropeLocationOK) {
                    isAvailable = true;
                    this.logger.debug(`PING check successful for ${host} from Europe.`);
                } else {
                    isAvailable = false;
                    this.logger.warn(`PING check failed (Europe locations reported packet loss) for ${host}.`);
                }
            } else {
                isAvailable = false;
                this.logger.warn(`PING check failed (No 'Europe' region found in API response) for ${host}.`);
            }
        } else {
             isAvailable = false;
             this.logger.error(`PING check via API failed (Invalid JSON response). Status: ${response.status}. Data: ${JSON.stringify(response.data)}`);
        }
    } catch (error: any) {
        isAvailable = false;
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || error.response?.status === 504) {
             this.logger.warn(`PING check via API timed out for ${host}. Assuming unavailable.`);
        } else {
             this.logger.error(`PING check via API failed (HTTP Error) for ${host}. Error: ${error.message}`);
        }
    }

    return { place, isAvailable };
  }
  // --- КІНЕЦЬ МЕТОДУ CHECK ---

  // --- ЦЕЙ МЕТОД ВИКЛИКАЄ CRONSERVICE ---
  // Використовуємо EVERY_3_MINUTES
  @Cron('*/3 * * * *', { 
    name: 'check-electricity-availability',
  })
  public async checkAndSaveElectricityAvailabilityStateOfAllPlaces(): Promise<void> {
    // --- ПЕРЕВІРКА ЗАМКА ---
    if (ElectricityAvailabilityService.isCronRunning) {
        this.logger.warn('Cron job "check-electricity-availability" is already running. Skipping this run.');
        return;
    }
    ElectricityAvailabilityService.isCronRunning = true;
    this.logger.log('Cron job "check-electricity-availability" (checkAndSave...) started.');
    // ----------------------

    try {
      const places = await this.placeRepository.getAllPlaces();
      this.logger.debug(`Cron: Loaded ${places.length} places to check.`);

      await Promise.all(places.map(async (place) => {
        if (place && !place.isDisabled) { 
            this.logger.debug(`Cron: Pushing place ${place.name} to check queue.`);
            this.place$.next(place); // Пушимо в потік
        } else if (place) {
            this.logger.debug(`Cron: Skipping disabled place ${place.name}.`);
        }
      }));

      this.logger.verbose('Cron job "check-electricity-availability" finished.');
    } catch (error) {
       this.logger.error(`Cron: Failed to load places or check availability: ${error}`, error instanceof Error ? error.stack : undefined);
    } finally {
       // --- ВІДПУСКАЄМО ЗАМОК ---
       ElectricityAvailabilityService.isCronRunning = false;
       this.logger.log('Cron job "check-electricity-availability" lock released.');
       // ------------------------
    }
  }
  // ---------------------------------------------

  private async handleAvailabilityChange(params: {
    readonly place: Place;
    readonly isAvailable: boolean;
  }): Promise<void> {
    const { place, isAvailable } = params;
    if (!place) {
        this.logger.error('handleAvailabilityChange called with undefined place.');
        return;
    }
    this.logger.log(`Handling availability change for ${place.name}: ${isAvailable ? 'AVAILABLE' : 'UNAVAILABLE'}`);
    try {
        const [latest] = await this.electricityRepository.getLatest({ placeId: place.id, limit: 1 });
        // Виправлено: is_available
        if (!latest || latest.is_available !== isAvailable) { 
          this.logger.log(`State changed for ${place.name}. Saving new state: ${isAvailable}`);
          await this.electricityRepository.save({ placeId: place.id, isAvailable });

          // --- ДОДАНО ВИКЛИК СПОВІЩЕННЯ ---
          this.logger.log(`Triggering notification for place ${place.id}`);
          // Викликаємо публічний метод з NotificationBotService
          await this.notificationBotService.notifyAllPlaceSubscribersAboutElectricityAvailabilityChange({ placeId: place.id });
          // ---------------------------------

        } else {
          this.logger.debug(`State for ${place.name} has not changed. Skipping save.`);
        }
    } catch (error) {
         this.logger.error(`Error saving availability change for ${place.id}: ${error}`, error instanceof Error ? error.stack : undefined);
    }
  }


  public async getLatestPlaceAvailability(params: {
    readonly placeId: string;
    readonly limit: number;
    readonly to?: Date; 
  }): Promise<
    ReadonlyArray<{
      readonly time: Date;
      readonly is_available: boolean; // Виправлено
    }>
  > {
    this.logger.debug(`Getting latest availability for place ${params.placeId} (limit ${params.limit})`);
    try {
        return await this.electricityRepository.getLatest({
            placeId: params.placeId,
            limit: params.limit,
            to: params.to
        });
    } catch (error) {
        this.logger.error(`Error in getLatestPlaceAvailability for ${params.placeId}: ${error}`, error instanceof Error ? error.stack : undefined);
        return []; 
    }
  }

  public async getTodayAndYesterdayStats(params: {
    readonly place: Place;
  }): Promise<{
    readonly history: {
      readonly today: ReadonlyArray<HistoryItem>;
      readonly yesterday: ReadonlyArray<HistoryItem>;
    };
    readonly lastStateBeforeToday?: boolean;
    readonly lastStateBeforeYesterday?: boolean;
  }> {
    const { place } = params;
    if (!place) {
        this.logger.error('getTodayAndYesterdayStats called with undefined place.');
        return { history: { today: [], yesterday: [] } };
    }
    this.logger.debug(`Getting today/yesterday stats for place ${place.id}`);
    try {
        const now = convertToTimeZone(new Date(), { timeZone: place.timezone });
        const todayStart = startOfDay(now);
        const yesterdayStart = startOfDay(addHours(todayStart, -2)); 
        const yesterdayEnd = endOfDay(yesterdayStart);

        const [todayHistory, yesterdayHistory] = await Promise.all([
          this.electricityRepository.getHistory({
            placeId: place.id,
            from: todayStart,
            to: now,
          }),
          this.electricityRepository.getHistory({
            placeId: place.id,
            from: yesterdayStart,
            to: yesterdayEnd,
          }),
        ]);

        const [lastStateBeforeToday] =
          await this.electricityRepository.getLatest({
            placeId: place.id,
            limit: 1,
            to: subMinutes(todayStart, 1),
          });

        const [lastStateBeforeYesterday] =
          await this.electricityRepository.getLatest({
            placeId: place.id,
            limit: 1,
            to: subMinutes(yesterdayStart, 1),
          });

        return {
          history: {
            today: todayHistory,
            yesterday: yesterdayHistory,
          },
          lastStateBeforeToday: lastStateBeforeToday?.is_available, // Виправлено
          lastStateBeforeYesterday: lastStateBeforeYesterday?.is_available, // Виправлено
        };
    } catch (error) {
         this.logger.error(`Error in getTodayAndYesterdayStats for ${place.id}: ${error}`, error instanceof Error ? error.stack : undefined);
         return { history: { today: [], yesterday: [] } };
    }
  }

  public async getMonthStats(params: {
    readonly place: Place;
    readonly dateFromTargetMonth: Date;
  }): Promise<{
    readonly totalMinutesAvailable: number;
    readonly totalMinutesUnavailable: number;
  }> {
    const { place, dateFromTargetMonth } = params;
    if (!place || !dateFromTargetMonth) {
        this.logger.error('getMonthStats called with undefined params.');
        return { totalMinutesAvailable: 0, totalMinutesUnavailable: 0 };
    }
    this.logger.debug(`Getting month stats for place ${place.id}, month: ${format(dateFromTargetMonth, 'yyyy-MM')}`);
    try {
        const start = convertToTimeZone(startOfMonth(dateFromTargetMonth), {
          timeZone: place.timezone,
        });
        const end = convertToTimeZone(endOfMonth(dateFromTargetMonth), {
          timeZone: place.timezone,
        });
        const history = await this.electricityRepository.getHistory({
          placeId: place.id,
          from: start,
          to: end,
        });
        if (!history || !history.length) { 
          this.logger.warn(`No history data found for month stats, place ${place.id}`);
          return { totalMinutesAvailable: 0, totalMinutesUnavailable: 0 };
        }
        let totalMinutesAvailable = 0;
        let totalMinutesUnavailable = 0;
        history.forEach(({ start, end, isEnabled }) => {
           if (!start || !end) { this.logger.error(`Invalid history item in getMonthStats: ${JSON.stringify({start, end, isEnabled})}`); return; }
           let durationInMinutes = 0;
           try {
              durationInMinutes = Math.abs(differenceInMinutes(new Date(end), new Date(start)));
           } catch (diffError) { this.logger.error(`Error calculating diff in getMonthStats: ${diffError}`); return; }
          if (isEnabled) {
            totalMinutesAvailable += durationInMinutes;
          } else {
            totalMinutesUnavailable += durationInMinutes;
          }
        });
         this.logger.debug(`Calculated month stats for place ${place.id}: Available=${totalMinutesAvailable}, Unavailable=${totalMinutesUnavailable}`);
        return { totalMinutesAvailable, totalMinutesUnavailable };
    } catch (error) {
        this.logger.error(`Error in getMonthStats for ${place.id}: ${error}`, error instanceof Error ? error.stack : undefined);
        return { totalMinutesAvailable: 0, totalMinutesUnavailable: 0 };
    }
  }

  public async getMonthStatsMessage(params: {
    readonly place: Place;
    readonly dateFromTargetMonth: Date;
  }): Promise<string> {
    if (!params.place) {
        this.logger.error('getMonthStatsMessage called with undefined place.');
        return '';
    }
    this.logger.debug(`Getting month stats message for place ${params.place.id}`);
    try {
        const { totalMinutesAvailable, totalMinutesUnavailable } =
          await this.getMonthStats(params); // Виклик виправлено

        const totalMinutes = totalMinutesAvailable + totalMinutesUnavailable;
        if (totalMinutes === 0) {
          this.logger.warn(`Total minutes for month stats message is zero for place ${params.place.id}`);
          return ''; 
        }

        const percentAvailable = Math.round(
          (100 * totalMinutesAvailable) / totalMinutes
        );
        const percentUnavailable = 100 - percentAvailable;
        const baseDate = convertToTimeZone(new Date(), {
          timeZone: params.place.timezone,
        });
        const baseDatePlusAvailable = addMinutes(
          baseDate,
          totalMinutesAvailable
        );
        const howLongAvailable = formatDistance(baseDate, baseDatePlusAvailable, {
          locale: uk,
          includeSeconds: false,
        });
        const baseDatePlusUnavailable = addMinutes(
          baseDate,
          totalMinutesUnavailable
        );
        const howLongUnavailable = formatDistance(
          baseDate,
          baseDatePlusUnavailable,
          {
            locale: uk,
            includeSeconds: false,
          }
        );

        const m = getMonth(params.dateFromTargetMonth);
        const mn =
          m === 0 ? 'січні' : m === 1 ? 'лютому' : m === 2 ? 'березні' :
          m === 3 ? 'квітні' : m === 4 ? 'травні' : m === 5 ? 'червні' :
          m === 6 ? 'липні' : m === 7 ? 'серпні' : m === 8 ? 'вересні' :
          m === 9 ? 'жовтні' : m === 10 ? 'листопаді' : 'грудні';

        return `У ${mn} ми насолоджувалися світлом ${percentAvailable}% часу (сумарно ${howLongAvailable}) і потерпали від темряви ${percentUnavailable}% часу (сумарно ${howLongUnavailable}).`;
    } catch (error) {
         this.logger.error(`Error in getMonthStatsMessage for ${params.place.id}: ${error}`, error instanceof Error ? error.stack : undefined);
         return '';
    }
  }
  private isGroup(params: { readonly chatId: number }): boolean {
    const result = params.chatId < 0;
    // this.logger.debug(`isGroup check for chatId ${params.chatId}: ${result}`); // Розкоментуйте для детального логування
    return result;
  }

  private async refreshAllPlacesAndBots(): Promise<void> {
    this.logger.log('>>> ENTERING refreshAllPlacesAndBots()'); // Лог входу в метод
    if (this.isRefreshingPlacesAndBots) {
      this.logger.warn('Refresh already in progress, skipping.');
      return;
    }

    this.logger.log('Starting refreshAllPlacesAndBots...');
    this.isRefreshingPlacesAndBots = true;
    let loadedPlaces: Place[] = []; // Змінна для зберігання завантажених місць
    let loadedBots: Bot[] = []; // Змінна для зберігання завантажених ботів
    try {
      this.logger.log('Attempting to load places from DB...'); // Лог
      loadedPlaces = await this.placeRepository.getAllPlaces();
      this.logger.log(`Loaded ${loadedPlaces.length} places from DB. IDs: ${JSON.stringify(loadedPlaces.map(p => p.id))}`);
      this.places = loadedPlaces.reduce<Record<string, Place>>(
        (res, place) => ({ ...res, [place.id]: place }),
        {}
      );

      this.logger.log('Attempting to load bot configurations from DB...'); // Лог
      loadedBots = await this.placeRepository.getAllPlaceBots();
      this.logger.log(`Loaded ${loadedBots.length} bots configurations from DB. place_ids: ${JSON.stringify(loadedBots.map(b => b.placeId))}`);

      const newPlaceBots: typeof this.placeBots = {};
      const activePlaceIds = new Set<string>(); // Зберігатимемо ID активних ботів

      // Спочатку обробляємо конфігурації
      for (const botConfig of loadedBots) {
        this.logger.log(`Processing bot config for place_id: ${botConfig.placeId}, isEnabled: ${botConfig.isEnabled}, bot_name: ${botConfig.botName}`); // Лог для кожного бота
        if (!botConfig.isEnabled) {
           this.logger.log(`Bot for place ${botConfig.placeId} is disabled in DB, skipping creation/update.`);
           continue; // Переходимо до наступної конфігурації
        }

        // Якщо бот активний, додаємо його ID до сету
        activePlaceIds.add(botConfig.placeId);

        const place = this.places[botConfig.placeId];
        if (!place) {
          this.logger.error(
            `Place ${botConfig.placeId} (from bots table) not found in loaded places cache - cannot process bot config` // Уточнено лог
          );
          continue;
        }

        const existingEntry = this.placeBots[botConfig.placeId];
        if (existingEntry) {
            // Бот вже існує в кеші
            if(existingEntry.bot.token !== botConfig.token) {
                // Токен змінився - потрібно перестворити інстанс
                this.logger.warn(`Token changed for place ${place.id}. Recreating bot instance.`);
                try {
                   // Спробуємо зупинити старий інстанс (може не працювати без polling)
                   if (existingEntry.telegramBot && typeof (existingEntry.telegramBot as any).stopPolling === 'function') {
                      await (existingEntry.telegramBot as any).stopPolling({ cancel: true }).catch(stopError => this.logger.error(`Non-critical error stopping previous instance polling for place ${place.id}: ${stopError}`));
                   }
                   if (existingEntry.telegramBot && typeof (existingEntry.telegramBot as any).close === 'function') {
                       await (existingEntry.telegramBot as any).close().catch(closeError => this.logger.error(`Non-critical error closing previous instance for place ${place.id}: ${closeError}`));
                   }
                   this.logger.log(`Stopped/closed previous instance for place ${place.id} due to token change.`);
                } catch (stopError) {
                   this.logger.error(`Error stopping/closing previous instance for place ${place.id}: ${stopError}`);
                }
                // Створюємо новий інстанс
                const createdInstance = this.createBot({ place, bot: botConfig });
                 if (createdInstance) {
                   newPlaceBots[botConfig.placeId] = { bot: botConfig, telegramBot: createdInstance };
                 } else {
                   this.logger.error(`Re-creation failed for place ${place.id} after token change.`);
                 }
            } else {
              // Токен не змінився, просто оновлюємо конфігурацію, зберігаючи старий інстанс
              newPlaceBots[botConfig.placeId] = { ...existingEntry, bot: botConfig };
              this.logger.log(`Bot instance for place ${place.id} already exists, config updated (token unchanged).`);
            }
        } else {
          // Якщо бота немає в кеші - створюємо новий
          this.logger.log(`Creating NEW bot instance for place ${place.id}`);
          const createdInstance = this.createBot({ place, bot: botConfig });
          if (createdInstance) {
             newPlaceBots[botConfig.placeId] = { bot: botConfig, telegramBot: createdInstance };
          } else {
             this.logger.error(`createBot returned undefined for place ${place.id}. Instance NOT created.`);
          }
        }
      } // кінець циклу for (const botConfig of loadedBots)

      // Тепер зупиняємо та видаляємо інстанси, яких НЕМАЄ в активних конфігураціях
      for (const placeId in this.placeBots) {
          if (!activePlaceIds.has(placeId)) { // Якщо ID зі старого кешу немає в новому списку активних
              this.logger.warn(`Bot for place ${placeId} seems removed from DB or disabled. Stopping and removing instance.`);
              const instanceToStop = this.placeBots[placeId]?.telegramBot;
               try {
                   if (instanceToStop && typeof (instanceToStop as any).stopPolling === 'function') {
                      await (instanceToStop as any).stopPolling({ cancel: true }).catch(stopError => this.logger.error(`Non-critical error stopping removed/disabled instance polling for place ${placeId}: ${stopError}`));
                   }
                   if (instanceToStop && typeof (instanceToStop as any).close === 'function') {
                      await (instanceToStop as any).close().catch(closeError => this.logger.error(`Non-critical error closing removed/disabled instance for place ${placeId}: ${closeError}`));
                   }
                   this.logger.log(`Stopped/closed removed/disabled instance for place ${placeId}`);
                } catch (stopError) {
                   this.logger.error(`Error stopping/closing removed/disabled instance for place ${placeId}: ${stopError}`);
                }
                // Не додаємо його до newPlaceBots, таким чином видаляючи з кешу
          }
      }

      this.placeBots = newPlaceBots; // Оновлюємо кеш ботів тільки активними/оновленими інстансами
      this.logger.log(`Finished processing bots configurations. Active instances in this.placeBots: ${Object.keys(this.placeBots).length}`);

    } catch (e) {
      this.logger.error(`>>> ERROR inside refreshAllPlacesAndBots during DB fetch or processing: ${e}`, e instanceof Error ? e.stack : undefined);
    } finally {
      this.isRefreshingPlacesAndBots = false;
      this.logger.log('>>> EXITING refreshAllPlacesAndBots()'); // Лог виходу з методу
    }
  }

  // Змінено: createBot тепер повертає створений екземпляр або undefined
  private createBot(params: {
    readonly place: Place;
    readonly bot: Bot;
  }): TelegramBot | undefined {
    const { place, bot } = params;
    try {
      this.logger.log(`Attempting to create bot instance for place ${place.id} (${place.name}) with token starting: ${bot.token ? bot.token.substring(0, 10) : 'NO_TOKEN'}...`); // Лог
      if (!bot.token) {
          this.logger.error(`Token is missing for bot config of place ${place.id}. Cannot create instance.`);
          return undefined;
      }
      // Створюємо без polling
      const telegramBot = new TelegramBot(bot.token);
      this.logger.log(`TelegramBot instance created for place ${place.id}. Attaching listeners...`); // Лог

      // Обробники подій
      telegramBot.on('polling_error', (error) => { // Все ще корисно для діагностики внутрішніх помилок
         this.logger.error(`${place.name}/${bot.botName} internal polling_error: ${error}`);
      });
      telegramBot.on('webhook_error', (error: any) => { // Додаємо обробник помилок вебхука
        // Безпечно перевіряємо наявність 'code' та 'message'
        const errorCode = error?.code ? `Code: ${error.code}` : '';
        const errorMessage = error?.message ? error.message : JSON.stringify(error);
        this.logger.error(`${place.name}/${bot.botName} webhook_error: ${errorCode} ${errorMessage}`);
      });
      telegramBot.on('error', (error) => { // Загальний обробник помилок
        this.logger.error(`${place.name}/${bot.botName} general error: ${error}`, error instanceof Error ? error.stack : undefined); // Додано stack
      });

      // Обробники команд
      // Додаємо try...catch навколо кожного виклику handle... для кращої діагностики
      telegramBot.onText(/\/start/, (msg) => {
        this.logger.debug(`Received /start for place ${place.id} via onText`); // Лог
        this.handleStartCommand({ msg, place, bot, telegramBot }).catch(err => this.logger.error(`Unhandled error in handleStartCommand: ${err}`, err instanceof Error ? err.stack : undefined)); // Додано instanceof
      });
      telegramBot.onText(/\/current/, (msg) => {
        this.logger.debug(`Received /current for place ${place.id} via onText`); // Лог
        this.handleCurrentCommand({ msg, place, bot, telegramBot }).catch(err => this.logger.error(`Unhandled error in handleCurrentCommand: ${err}`, err instanceof Error ? err.stack : undefined)); // Додано instanceof
      });
      telegramBot.onText(/\/subscribe/, (msg) => {
        this.logger.debug(`Received /subscribe for place ${place.id} via onText`); // Лог
        this.handleSubscribeCommand({ msg, place, bot, telegramBot }).catch(err => this.logger.error(`Unhandled error in handleSubscribeCommand: ${err}`, err instanceof Error ? err.stack : undefined)); // Додано instanceof
      });
      telegramBot.onText(/\/unsubscribe/, (msg) => {
        this.logger.debug(`Received /unsubscribe for place ${place.id} via onText`); // Лог
        this.handleUnsubscribeCommand({ msg, place, bot, telegramBot }).catch(err => this.logger.error(`Unhandled error in handleUnsubscribeCommand: ${err}`, err instanceof Error ? err.stack : undefined)); // Додано instanceof
      });
      telegramBot.onText(/\/stop/, (msg) => {
        this.logger.debug(`Received /stop for place ${place.id} via onText`); // Лог
        this.handleUnsubscribeCommand({ msg, place, bot, telegramBot }).catch(err => this.logger.error(`Unhandled error in handleUnsubscribeCommand (stop): ${err}`, err instanceof Error ? err.stack : undefined)); // Додано instanceof
      });
      telegramBot.onText(/\/stats/, (msg) => {
        this.logger.debug(`Received /stats for place ${place.id} via onText`); // Лог
        this.handleStatsCommand({ msg, place, bot, telegramBot }).catch(err => this.logger.error(`Unhandled error in handleStatsCommand: ${err}`, err instanceof Error ? err.stack : undefined)); // Додано instanceof
      });
      telegramBot.onText(/\/about/, (msg) => {
        this.logger.debug(`Received /about for place ${place.id} via onText`); // Лог
        this.handleAboutCommand({ msg, place, bot, telegramBot }).catch(err => this.logger.error(`Unhandled error in handleAboutCommand: ${err}`, err instanceof Error ? err.stack : undefined)); // Додано instanceof
      });

      this.logger.log(`Successfully created bot instance and attached listeners for place ${place.id}.`); // Лог
      return telegramBot; // Повертаємо створений екземпляр
    } catch (error) {
       this.logger.error(`>>> FAILED during new TelegramBot() or attaching listeners for place ${place.id}: ${error}`, error instanceof Error ? error.stack : undefined); // Лог помилки
       return undefined; // Повертаємо undefined у разі помилки
    }
  }

  // Метод для отримання інстансу бота
  public getMainTelegramBotInstance(): TelegramBot | undefined {
    this.logger.log(`getMainTelegramBotInstance called. Current this.placeBots keys: ${JSON.stringify(Object.keys(this.placeBots))}`); // Лог
    // Шукаємо перший активний бот (можна вдосконалити, якщо ботів багато)
    const activeBotEntry = Object.values(this.placeBots).find(entry => entry.bot.isEnabled);
    if (activeBotEntry) {
      this.logger.log(`Found active bot instance for placeId: ${activeBotEntry.bot.placeId}`); // Лог
      return activeBotEntry.telegramBot;
    } else {
      this.logger.warn('No active bot instance found in this.placeBots during getMainTelegramBotInstance');
      return undefined;
    }
  }

  private async notifyBotDisabled(params: {
    readonly chatId: number;
    readonly telegramBot: TelegramBot;
  }): Promise<void> {
    const { chatId, telegramBot } = params;
    // Додаємо перевірку на null/undefined
    if (!chatId || !telegramBot) {
        this.logger.error('Missing parameters in notifyBotDisabled');
        return;
    }
    try { // Додано try...catch
        this.logger.log(`Sending MSG_DISABLED to chat ${chatId}`); // Лог
        await telegramBot.sendMessage(chatId, MSG_DISABLED, { parse_mode: 'HTML' });
    } catch (error) {
        this.logger.error(`Error sending MSG_DISABLED to chat ${chatId}: ${error}`); // Лог помилки
    }
  }

  private async sleep(params: { readonly ms: number }): Promise<void> {
    // this.logger.debug(`Sleeping for ${params.ms} ms`); // Розкоментуйте для дуже детального логування
    // Додаємо перевірку на null/undefined
    if (params?.ms > 0) {
        return new Promise((r) => setTimeout(r, params.ms));
    } else {
        return Promise.resolve(); // Не чекаємо, якщо ms не задано або <= 0
    }
  }

  private async composeListedBotsMessage(): Promise<string> {
      this.logger.log('Composing listed bots message...'); // Лог
      try { // try...catch охоплює ВЕСЬ код методу
          const stats = await this.placeRepository.getListedPlaceBotStats(); // stats оголошено тут

          // Перевірка stats всередині try
          if (!stats || stats.length === 0) {
              this.logger.log('No listed bot stats found.'); // Лог
              return ''; // Повернення всередині try
          }

          // Весь наступний код тепер всередині try і має доступ до stats
          const totalUsers = stats.reduce<number>(
            (res, { numberOfUsers }) => res + Number(numberOfUsers), 0
          );

          let res = `Наразі сервісом користуються ${totalUsers} користувачів у ${stats.length} ботах:\n`;

          stats.forEach(({ placeName, botName, numberOfUsers }) => {
            res += `@${botName}\n${placeName}: ${numberOfUsers} користувачів\n`;
          });

          this.logger.log(`Composed listed bots message: "${res.substring(0,50)}..."`); // Лог результату
          return res + '\n'; // Повернення результату всередині try

      } catch (error) {
          this.logger.error(`Error composing listed bots message: ${error}`, error instanceof Error ? error.stack : undefined); // Лог помилки
          return ''; // Повертаємо порожній рядок у разі помилки
      }
    }

} // <-- Кінець класу NotificationBotService
