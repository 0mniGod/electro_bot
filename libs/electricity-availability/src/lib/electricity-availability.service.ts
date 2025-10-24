import { Place } from '@electrobot/domain';
import { PlaceRepository } from '@electrobot/place-repo';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
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

const CHECK_INTERVAL_IN_MINUTES = 2; // Це більше не використовується для Cron, але залишаємо для 'availabilityChange$'

@Injectable()
export class ElectricityAvailabilityService {
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

  // --- ДОПОМІЖНИЙ МЕТОД ---
  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // --- МЕТОД З ПОВТОРНИМИ СПРОБАМИ (5) ---
  private async checkWithRetries(place: Place): Promise<{
    readonly place: Place;
    readonly isAvailable: boolean;
  }> {
    const retries = 5; // <-- ЗБІЛЬШЕНО ДО 5 СПРОБ
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

  // --- ОНОВЛЕНИЙ CRON (КОЖНІ 3 ХВИЛИНИ + ЗАМОК) ---
  @Cron('*/3 * * * *', { // <-- ЗМІНЕНО НА КОЖНІ 3 ХВИЛИНИ
    name: 'check-electricity-availability',
  })
  public async checkAndSaveElectricityAvailabilityStateOfAllPlaces(): Promise<void> {
    this.logger.verbose('Cron job "check-electricity-availability" triggered.');
    
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
            this.logger.debug(`Cron: Checking place ${place.name}...`);
            const { isAvailable } = await this.checkWithRetries(place); // Викликаємо з повторними спробами
            await this.handleAvailabilityChange({ place, isAvailable });
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
  // --- КІНЕЦЬ ОНОВЛЕНОГО CRON ---

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
          
          // --- ВИКЛИК СПОВІЩЕННЯ ---
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
  private async composePlaceMonthStatsMessage(params: {
    readonly place: Place;
    readonly dateFromTargetMonth: Date;
  }): Promise<string> {
      this.logger.log(`Composing monthly stats message for place ${params.place.id}`); // Лог
      try { // Додано try...catch
          const monthStats =
            await this.electricityAvailabilityService.getMonthStats(params); // Виправлено: getMonthStats

          if (!monthStats) {
            this.logger.warn(`No monthly stats data found for place ${params.place.id}`); // Лог
            return '';
          }
          this.logger.log(`Monthly stats data for place ${params.place.id}: ${JSON.stringify(monthStats)}`); // Лог даних

          const totalMinutes =
            monthStats.totalMinutesAvailable + monthStats.totalMinutesUnavailable;
          // Додаємо перевірку на нуль, щоб уникнути ділення на нуль
          if (totalMinutes === 0) {
              this.logger.warn(`Total minutes for month stats is zero for place ${params.place.id}`);
              return '';
          }
          const percentAvailable = Math.round( // Використовуємо Math.round для кращого заокруглення
            (100 * monthStats.totalMinutesAvailable) / totalMinutes
          );
          const percentUnavailable = 100 - percentAvailable;
          const baseDate = convertToTimeZone(new Date(), {
            timeZone: params.place.timezone,
          });
          const baseDatePlusAvailable = addMinutes(
            baseDate,
            monthStats.totalMinutesAvailable
          );
          const howLongAvailable = formatDistance(baseDate, baseDatePlusAvailable, {
            locale: uk,
            includeSeconds: false,
          });
          const baseDatePlusUnavailable = addMinutes(
            baseDate,
            monthStats.totalMinutesUnavailable
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

          const result = `У ${mn} ми насолоджувалися світлом ${percentAvailable}% часу (сумарно ${howLongAvailable}) і потерпали від темряви ${percentUnavailable}% часу (сумарно ${howLongUnavailable}).`;
          this.logger.log(`Composed monthly stats message for place ${params.place.id}: "${result.substring(0,50)}..."`); // Лог результату
          return result;
      } catch (error) {
          this.logger.error(`Error composing monthly stats for place ${params.place.id}: ${error}`, error instanceof Error ? error.stack : undefined); // Лог помилки
          return ''; // Повертаємо порожній рядок у разі помилки
      }
  }

  private async handleAboutCommand(params: {
    readonly msg: TelegramBot.Message;
    readonly place: Place;
    readonly bot: Bot;
    readonly telegramBot: TelegramBot;
  }): Promise<void> {
      const { msg, place, telegramBot } = params;
      // Додаємо перевірку на null/undefined
      if (!msg || !place || !telegramBot) {
        this.logger.error('Missing parameters in handleAboutCommand');
        return;
      }
      this.logger.log(`Handling /about command for chat ${msg.chat.id} in place ${place.id}`); // Лог
      if (this.isGroup({ chatId: msg.chat.id })) {
         this.logger.warn(`Skipping group message: ${JSON.stringify(msg)}`);
         return;
       }
      if (place.isDisabled) {
        await this.notifyBotDisabled({ chatId: msg.chat.id, telegramBot });
        return;
       }
       try { // Додано try...catch
          await this.userRepository.saveUserAction({
             placeId: place.id,
             chatId: msg.chat.id,
             command: 'about',
          });
          this.logger.log(`Handling /about message content: ${JSON.stringify(msg)}`); // Додатковий лог
          const listedBotsMessage = await this.composeListedBotsMessage();
          await telegramBot.sendMessage(
              msg.chat.id,
              RESP_ABOUT({ listedBotsMessage }),
              {
                parse_mode: 'HTML',
              }
          );
          this.logger.log(`Sent /about response to chat ${msg.chat.id}`); // Лог відправки
       } catch (error) {
          this.logger.error(`Error in handleAboutCommand for chat ${msg.chat.id}: ${error}`, error instanceof Error ? error.stack : undefined); // Лог помилки
       }
  }

  public async notifyAllPlaceSubscribersAboutElectricityAvailabilityChange(params: { // ЗМІНЕНО: private -> public
    readonly placeId: string;
  }): Promise<void> {
    const { placeId } = params;
    // --- ДОДАНО ЛОГУВАННЯ ---
    this.logger.log(`Starting notifyAllPlaceSubscribersAboutElectricityAvailabilityChange for place ${placeId}`);
    // -----------------------
    const place = this.places[placeId];
    if (!place) {
      this.logger.error(
        `Place ${placeId} not found in memory cache - skipping subscriber notification`
      );
      return;
    }
    if (place.isDisabled) {
      this.logger.log(`Place ${placeId} is disabled, skipping notification.`); // Лог
      return;
    }
    try { // Додано try...catch
      const [latest, previous] =
        await this.electricityAvailabilityService.getLatestPlaceAvailability({
          placeId,
          limit: 2,
        });
      if (!latest) {
        this.logger.error(
          `Electricity availability changed event, however no availability data in the repo for place ${placeId}`
        );
        return;
      }
      // --- ДОДАНО ЛОГУВАННЯ ---
      this.logger.log(`Latest/Previous availability for notification (place ${placeId}): ${JSON.stringify({latest, previous})}`);
      // -----------------------

      let scheduleEnableMoment: Date | undefined;
      let schedulePossibleEnableMoment: Date | undefined;
      let scheduleDisableMoment: Date | undefined;
      let schedulePossibleDisableMoment: Date | undefined;

      // --- Закоментований блок ---
      /*
      if (place.kyivScheduleGroupId === 0 || place.kyivScheduleGroupId) { ... }
      */
      // --- Кінець закоментованого блоку ---

      const latestTime = convertToTimeZone(latest.time, {
        timeZone: place.timezone,
      });
      const when = format(latestTime, 'HH:mm dd.MM', { locale: uk });
      let response: string;
      if (!previous) {
        this.logger.log(`No previous state found for place ${placeId}, sending short notification.`); // Лог
        response = latest.is_available // <-- ВИПРАВЛЕНО: isAvailable -> is_available
          ? RESP_ENABLED_SHORT({
              when,
              place: place.name,
              scheduleDisableMoment, // undefined
              schedulePossibleDisableMoment, // undefined
            })
          : RESP_DISABLED_SHORT({
              when,
              place: place.name,
              scheduleEnableMoment, // undefined
              schedulePossibleEnableMoment, // undefined
            });
      } else {
        const previousTime = convertToTimeZone(previous.time, {
          timeZone: place.timezone,
        });
        const howLong = formatDistance(latestTime, previousTime, {
          locale: uk,
          includeSeconds: false,
        });
        const diffInMinutes = Math.abs(
          differenceInMinutes(previousTime, latestTime)
        );
        this.logger.log(`Calculating notification for place ${placeId}. Time diff: ${diffInMinutes} minutes.`); // Лог

        if (latest.is_available) { // <-- ВИПРАВЛЕНО: isAvailable -> is_available
          response =
            diffInMinutes <= MIN_SUSPICIOUS_DISABLE_TIME_IN_MINUTES
              ? RESP_ENABLED_SUSPICIOUS({ when, place: place.name })
              : RESP_ENABLED_DETAILED({
                  when,
                  howLong,
                  place: place.name,
                  scheduleDisableMoment, // undefined
                  schedulePossibleDisableMoment, // undefined
                });
        } else {
          response =
            diffInMinutes <= MIN_SUSPICIOUS_DISABLE_TIME_IN_MINUTES
              ? RESP_DISABLED_SUSPICIOUS({ when, place: place.name })
              : RESP_DISABLED_DETAILED({
                  when,
                  howLong,
                  place: place.name,
                  scheduleEnableMoment, // undefined
                  schedulePossibleEnableMoment, // undefined
                });
        }
      }
      // --- ДОДАНО ЛОГУВАННЯ ---
      this.logger.log(`Prepared notification message for place ${placeId}: "${response.substring(0, 50)}..."`);
      // -----------------------
      // Переконуємось, що place існує перед викликом
      if (place) {
          this.notifyAllPlaceSubscribers({ place, msg: response });
      } else {
          this.logger.error(`Place object was null/undefined before calling notifyAllPlaceSubscribers for placeId ${placeId}`);
      }
    } catch (error) {
      this.logger.error(`Error in notifyAllPlaceSubscribersAboutElectricityAvailabilityChange for place ${placeId}: ${error}`, error instanceof Error ? error.stack : undefined); // Лог помилки
    }
  }

  private async notifyAllPlaceSubscribersAboutPreviousMonthStats(params: {
    readonly place: Place;
  }): Promise<void> {
    const { place } = params;
    // Додаємо перевірку на null/undefined
    if (!place) {
        this.logger.error('Missing place parameter in notifyAllPlaceSubscribersAboutPreviousMonthStats');
        return;
    }
    this.logger.log(`Starting notifyAllPlaceSubscribersAboutPreviousMonthStats for place ${place.id}`); // Лог
    if (place.isDisabled) {
      this.logger.log(`Place ${place.id} is disabled, skipping monthly stats.`); // Лог
      return;
    }
    try { // Додано try...catch
        const dateFromPreviousMonth = addMonths(new Date(), -1);
        const statsMessage = await this.composePlaceMonthStatsMessage({ place, dateFromTargetMonth: dateFromPreviousMonth });
        if (!statsMessage) {
          this.logger.log(
            `No monthly stats message generated for ${place.name} - skipping subscriber notification`
          );
          return;
        }
        const response = RESP_PREVIOUS_MONTH_SUMMARY({ statsMessage });
        // --- ДОДАНО ЛОГУВАННЯ ---
        this.logger.log(`Prepared monthly stats notification for place ${place.id}: "${response.substring(0, 50)}..."`);
        // -----------------------
        this.notifyAllPlaceSubscribers({ place, msg: response });
    } catch (error) {
        this.logger.error(`Error in notifyAllPlaceSubscribersAboutPreviousMonthStats for place ${place.id}: ${error}`, error instanceof Error ? error.stack : undefined); // Лог помилки
    }
  }

  private async notifyAllPlaceSubscribers(params: {
    readonly place: Place;
    readonly msg: string;
  }): Promise<void> {
    const { place, msg } = params;
    // Додаємо перевірку на null/undefined
    if (!place || !msg) {
        this.logger.error('Missing parameters in notifyAllPlaceSubscribers');
        return;
    }
    this.logger.log(`Starting notifyAllPlaceSubscribers for place ${place.id}`); // Лог
    const botEntry = this.placeBots[place.id];
    if (!botEntry) {
      this.logger.warn(
        `No bot instance found in cache for ${place.name} during notifyAllPlaceSubscribers` // Уточнено лог
      );
      return;
    }
    // Додаємо перевірку на botEntry.bot
    if (!botEntry.bot) {
       this.logger.error(`Corrupted botEntry found for place ${place.id} - missing 'bot' property.`);
       return;
    }
    if (!botEntry.bot.isEnabled) {
      this.logger.log(
        `Bot config for ${place.name} is disabled - skipping subscriber notification` // Уточнено лог
      );
      return;
    }
    let subscribers: Array<{ chatId: number | string }> = []; // Оголошуємо заздалегідь, тип може бути string або number
    try { // Додано try...catch для отримання підписників
      subscribers = await this.userRepository.getAllPlaceUserSubscriptions({ placeId: place.id });
      this.logger.log(`Attempting to notify ${subscribers.length} subscribers of ${place.name}`); // Лог кількості
    } catch (error) {
       this.logger.error(`Error fetching subscribers for place ${place.id}: ${error}`, error instanceof Error ? error.stack : undefined); // Лог помилки
       return; // Виходимо, якщо не можемо отримати підписників
    }

    // Додаємо лічильники для статистики
    let successCount = 0;
    let blockedCount = 0;
    let errorCount = 0;

    for (const subscriber of subscribers) {
      // Переконуємось, що chatId - це число
      const chatId = Number(subscriber.chatId);
      if (isNaN(chatId)) {
          this.logger.error(`Invalid chatId found for place ${place.id}: ${subscriber.chatId}`);
          continue;
      }
      // Переконуємось, що є екземпляр telegramBot
      if (!botEntry.telegramBot) {
          this.logger.error(`Missing telegramBot instance in botEntry for place ${place.id} while notifying chat ${chatId}`);
          errorCount++;
          continue;
      }

      try { // Додано try...catch для кожного відправлення
        await this.sleep({ ms: BULK_NOTIFICATION_DELAY_IN_MS });
        await botEntry.telegramBot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
        // this.logger.debug(`Sent notification to chat ${chatId} for place ${place.id}`); // Лог відправки (закоментовано, щоб зменшити шум)
        successCount++;
      } catch (e: any) {
        if (
          e?.code === 'ETELEGRAM' &&
          e?.message?.includes('403') &&
          (e.message?.includes('blocked by the user') || e.message?.includes('user is deactivated'))
        ) {
          this.logger.log(`User ${chatId} blocked bot for place ${place.id}. Removing subscription.`); // Лог блокування
          blockedCount++;
          try { // Додано try...catch для видалення підписки
             await this.userRepository.removeUserSubscription({ placeId: place.id, chatId });
          } catch (removeError) {
             this.logger.error(`Error removing subscription for blocked user ${chatId}, place ${place.id}: ${removeError}`); // Лог помилки видалення
          }
        } else {
          errorCount++;
          this.logger.error(`Failed to send notification to chat ${chatId} for place ${place.id}: ${JSON.stringify(e)}`, e instanceof Error ? e.stack : undefined); // Лог іншої помилки відправки
        }
      }
    }
    this.logger.log(
      `Finished notifying subscribers of ${place.name}. Success: ${successCount}, Blocked: ${blockedCount}, Errors: ${errorCount}` // Додано статистику
    );
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
