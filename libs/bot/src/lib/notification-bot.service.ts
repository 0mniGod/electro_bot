import {
  ElectricityAvailabilityService,
  // KyivElectricstatusScheduleService, // Закоментовано імпорт
} from '@electrobot/electricity-availability';
import { UserRepository } from '@electrobot/user-repo';
// Додаємо OnModuleInit до імпортів з @nestjs/common
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
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
// Додаємо implements OnModuleInit до класу
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
    // private readonly kyivElectricstatusScheduleService: KyivElectricstatusScheduleService, // Закоментовано ін'єкцію залежності
    private readonly userRepository: UserRepository,
    private readonly placeRepository: PlaceRepository
  ) {
    this.logger.log('>>> Constructor called'); // Лог конструктора
    // Виклик refreshAllPlacesAndBots та setInterval перенесено в onModuleInit

    // Підписка на зміни доступності
    this.electricityAvailabilityService.availabilityChange$.subscribe(
      ({ placeId }) => {
        this.logger.log(`Received availability change event for placeId: ${placeId}`);
        try { // Додано try-catch для безпеки
          this.notifyAllPlaceSubscribersAboutElectricityAvailabilityChange({
            placeId,
          });
        } catch (error) {
           this.logger.error(`Error handling availabilityChange$ for place ${placeId}: ${error}`, error instanceof Error ? error.stack : undefined);
        }
      }
    );
    this.logger.log('>>> Constructor finished'); // Лог завершення конструктора
  }

  // --- ДОДАНО МЕТОД onModuleInit ---
  async onModuleInit(): Promise<void> {
    this.logger.log('>>> ENTERING onModuleInit()'); // Лог входу в метод
    this.logger.log('Starting initial refresh...');
    try {
      await this.refreshAllPlacesAndBots(); // Чекаємо завершення першого оновлення
      // Запускаємо періодичне оновлення ТІЛЬКИ ПІСЛЯ першого успішного
      const refreshRate = 10 * 60 * 1000; // 10 min
      // Перевіряємо, чи setInterval вже не запущено (про всяк випадок)
      if (!(global as any).botRefreshInterval) {
         (global as any).botRefreshInterval = setInterval(() => {
             this.logger.log('>>> Interval triggered: calling refreshAllPlacesAndBots()'); // Лог виклику з інтервалу
             this.refreshAllPlacesAndBots().catch(err => { // Додано catch для помилок в інтервалі
                 this.logger.error(`Error during scheduled refreshAllPlacesAndBots: ${err}`, err instanceof Error ? err.stack : undefined);
             });
         }, refreshRate);
         this.logger.log(`Periodic refresh scheduled every ${refreshRate / 1000 / 60} minutes.`);
      } else {
         this.logger.warn('Periodic refresh interval already set.');
      }
    } catch (error) {
      this.logger.error(`>>> CRITICAL ERROR inside onModuleInit during initial refresh: ${error}`, error instanceof Error ? error.stack : undefined);
    }
    this.logger.log('>>> EXITING onModuleInit()'); // Лог виходу з методу
  }
  // ------------------------------------

  public async notifyAllPlacesAboutPreviousMonthStats(): Promise<void> {
    const allPlaces = Object.values(this.places);
    this.logger.log(`Starting notifyAllPlacesAboutPreviousMonthStats for ${allPlaces.length} places.`); // Лог
    for (const place of allPlaces) {
      if (!place || place.isDisabled || place.disableMonthlyStats) { // Додано перевірку на place
        this.logger.verbose(`Skipping monthly notification for ${place?.name || 'unknown place'} (isDisabled: ${place?.isDisabled}, disableMonthlyStats: ${place?.disableMonthlyStats})`);
        continue;
      }
      try { // Додано try...catch
        await this.notifyAllPlaceSubscribersAboutPreviousMonthStats({ place });
      } catch (error) {
        this.logger.error(`Error sending monthly stats for place ${place?.id || 'unknown id'}: ${error}`); // Лог помилки
      }
    }
    this.logger.log(`Finished notifyAllPlacesAboutPreviousMonthStats.`); // Лог
  }

  private async handleStartCommand(params: {
    readonly msg: TelegramBot.Message;
    readonly place: Place;
    readonly bot: Bot;
    readonly telegramBot: TelegramBot;
  }): Promise<void> {
    const { msg, place, telegramBot } = params;
    // Додаємо перевірку на null/undefined
    if (!msg || !place || !telegramBot) {
        this.logger.error('Missing parameters in handleStartCommand');
        return;
    }
    this.logger.log(`Handling /start command for chat ${msg.chat.id} in place ${place.id}`); // Лог
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
          command: 'start',
        });
        this.logger.log(`Handling /start message content: ${JSON.stringify(msg)}`); // Додатковий лог
        const listedBotsMessage = await this.composeListedBotsMessage();
        await telegramBot.sendMessage(
          msg.chat.id,
          RESP_START({ place: place.name, listedBotsMessage }),
          { parse_mode: 'HTML' }
        );
        this.logger.log(`Sent /start response to chat ${msg.chat.id}`); // Лог відправки
    } catch (error) {
        this.logger.error(`Error in handleStartCommand for chat ${msg.chat.id}: ${error}`, error instanceof Error ? error.stack : undefined); // Лог помилки
    }
  }

  private async handleCurrentCommand(params: {
    readonly msg: TelegramBot.Message;
    readonly place: Place;
    readonly bot: Bot;
    readonly telegramBot: TelegramBot;
  }): Promise<void> {
    const { msg, place, telegramBot } = params;
    // Додаємо перевірку на null/undefined
    if (!msg || !place || !telegramBot) {
        this.logger.error('Missing parameters in handleCurrentCommand');
        return;
    }
    this.logger.log(`Handling /current command for chat ${msg.chat.id} in place ${place.id}`); // Лог
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
          command: 'current',
        });
        this.logger.log(`Handling /current message content: ${JSON.stringify(msg)}`); // Додатковий лог
        const [latest] =
          await this.electricityAvailabilityService.getLatestPlaceAvailability({
            placeId: place.id,
            limit: 1,
          });
        if (!latest) {
          this.logger.warn(`No latest availability info found for place ${place.id}`); // Лог
          await telegramBot.sendMessage(
            msg.chat.id,
            RESP_NO_CURRENT_INFO({ place: place.name }),
            { parse_mode: 'HTML' }
          );
          return;
        }
        this.logger.log(`Latest availability for place ${place.id}: ${JSON.stringify(latest)}`); // Лог даних
        const changeTime = convertToTimeZone(latest.time, {
          timeZone: place.timezone,
        });
        const now = convertToTimeZone(new Date(), { timeZone: place.timezone });
        const when = format(changeTime, 'd MMMM о HH:mm', { locale: uk });
        const howLong = formatDistance(now, changeTime, {
          locale: uk,
          includeSeconds: false,
        });

        let scheduleEnableMoment: Date | undefined;
        let schedulePossibleEnableMoment: Date | undefined;
        let scheduleDisableMoment: Date | undefined;
        let schedulePossibleDisableMoment: Date | undefined;

        // --- Закоментований блок ---
        /*
        if (place.kyivScheduleGroupId === 0 || place.kyivScheduleGroupId) { ... }
        */
        // --- Кінець закоментованого блоку ---

        const response = latest.isAvailable
          ? RESP_CURRENTLY_AVAILABLE({
              when,
              howLong,
              place: place.name,
              scheduleDisableMoment, // Буде undefined
              schedulePossibleDisableMoment, // Буде undefined
            })
          : RESP_CURRENTLY_UNAVAILABLE({
              when,
              howLong,
              place: place.name,
              scheduleEnableMoment, // Буде undefined
              schedulePossibleEnableMoment, // Буде undefined
            });
        await telegramBot.sendMessage(msg.chat.id, response, {
          parse_mode: 'HTML',
        });
        this.logger.log(`Sent /current response to chat ${msg.chat.id}`); // Лог відправки
    } catch (error) {
        this.logger.error(`Error in handleCurrentCommand for chat ${msg.chat.id}: ${error}`, error instanceof Error ? error.stack : undefined); // Лог помилки
    }
  }

  private async handleSubscribeCommand(params: {
    readonly msg: TelegramBot.Message;
    readonly place: Place;
    readonly bot: Bot;
    readonly telegramBot: TelegramBot;
  }): Promise<void> {
    const { msg, place, telegramBot } = params;
    // Додаємо перевірку на null/undefined
    if (!msg || !place || !telegramBot) {
        this.logger.error('Missing parameters in handleSubscribeCommand');
        return;
    }
    this.logger.log(`Handling /subscribe command for chat ${msg.chat.id} in place ${place.id}`); // Лог
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
            command: 'subscribe',
          });
        this.logger.log(`Handling /subscribe message content: ${JSON.stringify(msg)}`); // Додатковий лог
        const added = await this.userRepository.addUserSubscription({
          placeId: place.id,
          chatId: msg.chat.id,
        });
        const response = added
          ? RESP_SUBSCRIPTION_CREATED({ place: place.name })
          : RESP_SUBSCRIPTION_ALREADY_EXISTS({ place: place.name });
        await telegramBot.sendMessage(msg.chat.id, response, {
          parse_mode: 'HTML',
        });
        this.logger.log(`Sent /subscribe response (added=${added}) to chat ${msg.chat.id}`); // Лог відправки
     } catch (error) {
        this.logger.error(`Error in handleSubscribeCommand for chat ${msg.chat.id}: ${error}`, error instanceof Error ? error.stack : undefined); // Лог помилки
     }
  }

  private async handleUnsubscribeCommand(params: {
    readonly msg: TelegramBot.Message;
    readonly place: Place;
    readonly bot: Bot;
    readonly telegramBot: TelegramBot;
  }): Promise<void> {
    const { msg, place, telegramBot } = params;
     // Додаємо перевірку на null/undefined
    if (!msg || !place || !telegramBot) {
        this.logger.error('Missing parameters in handleUnsubscribeCommand');
        return;
    }
    this.logger.log(`Handling /unsubscribe command for chat ${msg.chat.id} in place ${place.id}`); // Лог
    if (this.isGroup({ chatId: msg.chat.id })) {
       this.logger.warn(`Skipping group message: ${JSON.stringify(msg)}`);
       return;
     }
     try { // Додано try...catch
        await this.userRepository.saveUserAction({
          placeId: place.id,
          chatId: msg.chat.id,
          command: 'unsubscribe',
        });
        this.logger.log(`Handling /unsubscribe message content: ${JSON.stringify(msg)}`); // Додатковий лог
        const removed = await this.userRepository.removeUserSubscription({
          placeId: place.id,
          chatId: msg.chat.id,
        });
        const response = removed
          ? RESP_UNSUBSCRIBED({ place: place.name })
          : RESP_WAS_NOT_SUBSCRIBED({ place: place.name });
        await telegramBot.sendMessage(msg.chat.id, response, {
          parse_mode: 'HTML',
        });
        this.logger.log(`Sent /unsubscribe response (removed=${removed}) to chat ${msg.chat.id}`); // Лог відправки
     } catch (error) {
        this.logger.error(`Error in handleUnsubscribeCommand for chat ${msg.chat.id}: ${error}`, error instanceof Error ? error.stack : undefined); // Лог помилки
     }
  }

  // TODO: refactor (make cleaner)
  private async handleStatsCommand(params: {
    readonly msg: TelegramBot.Message;
    readonly place: Place;
    readonly bot: Bot;
    readonly telegramBot: TelegramBot;
  }): Promise<void> {
      const { msg, place, telegramBot } = params;
      // Додаємо перевірку на null/undefined
      if (!msg || !place || !telegramBot) {
        this.logger.error('Missing parameters in handleStatsCommand');
        return;
      }
      this.logger.log(`Handling /stats command for chat ${msg.chat.id} in place ${place.id}`); // Лог
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
            command: 'stats',
          });
          this.logger.log(`Handling /stats message content: ${JSON.stringify(msg)}`); // Додатковий лог
          const stats = await this.electricityAvailabilityService.getTodayAndYesterdayStats({
            place,
          });
          // Перевірка на null/undefined для stats
          if (!stats || !stats.history) {
              this.logger.error(`Failed to get stats data for place ${place.id}`);
              await telegramBot.sendMessage(msg.chat.id, 'Помилка отримання статистики.', { parse_mode: 'HTML' });
              return;
          }
          this.logger.log(`Stats data for place ${place.id}: ${JSON.stringify(stats)}`); // Лог статистики

          let response = '';

          // Вчорашня статистика
          if (
            (stats.history.yesterday && // Додано перевірку
              stats.history.yesterday.length > 1) ||
            stats.lastStateBeforeYesterday !== undefined
          ) {
            response += `${EMOJ_KISS} Вчора:`;

            if (
              stats.history.yesterday && // Додано перевірку
              stats.history.yesterday.length > 1
            ) {
              const yesterday = stats.history.yesterday;

              const baseDate = new Date();
              let baseDatePlusAvailable = new Date();
              let baseDatePluesUnavailable = new Date();

              yesterday.forEach(({ start, end, isEnabled }, i) => {
                 // Додаємо перевірку на start/end
                 if (!start || !end) return;
                const s =
                  i === 0
                    ? convertToTimeZone(start, { timeZone: place.timezone })
                    : start;
                const e =
                  i === yesterday.length - 1
                    ? convertToTimeZone(end, { timeZone: place.timezone })
                    : end;
                // Виправлено: різниця має бути між end та start, і обережно з типами
                let durationInMinutes = 0;
                try {
                   durationInMinutes = Math.abs(differenceInMinutes(new Date(e), new Date(s)));
                } catch (diffError) {
                   this.logger.error(`Error calculating differenceInMinutes for yesterday stats: ${diffError}`);
                   return; // Пропускаємо цей запис, якщо дати невалідні
                }


                if (isEnabled) {
                  baseDatePlusAvailable = addMinutes(
                    baseDatePlusAvailable,
                    durationInMinutes
                  );
                } else {
                  baseDatePluesUnavailable = addMinutes(
                    baseDatePluesUnavailable,
                    durationInMinutes
                  );
                }
              });

              const howLongAvailable = formatDistance(
                baseDate, // Змінено порядок аргументів для коректного відображення
                baseDatePlusAvailable,
                { locale: uk, includeSeconds: false }
              );
              const howLongUnavailable = formatDistance(
                baseDate, // Змінено порядок аргументів
                baseDatePluesUnavailable,
                { locale: uk, includeSeconds: false }
              );

              response = `${response}\nЗі світлом: ${howLongAvailable}\nБез світла: ${howLongUnavailable}`;

              yesterday.forEach(({ start, end, isEnabled }, i) => {
                 // Додаємо перевірку на start/end
                 if (!start || !end) return;
                const emoji = isEnabled ? EMOJ_BULB : EMOJ_MOON;
                const s = format(new Date(start), 'HH:mm', { locale: uk }); // Додано new Date()
                const e = format(new Date(end), 'HH:mm', { locale: uk });   // Додано new Date()
                const duration = formatDistance(new Date(end), new Date(start), { // Додано new Date()
                  locale: uk,
                  includeSeconds: false,
                });
                const entry =
                  i === 0
                    ? `${emoji} до ${e}`
                    : i === yesterday.length - 1
                    ? `${emoji} з ${s}`
                    : `${emoji} ${s}-${e} (${duration})`;

                response = `${response}\n${entry}`;
              });
            } else {
              response += stats.lastStateBeforeYesterday
                ? ' постійно зі світлом'
                : ' взагалі без світла';
            }
          }

          // Сьогоднішня статистика
          if (
            (stats.history.today && // Додано перевірку
             stats.history.today.length > 1) ||
            stats.lastStateBeforeToday !== undefined
          ) {
            if (response.length > 0) {
              response += '\n\n';
            }
            response += `${EMOJ_KISS_HEART} Сьогодні:`;

            if (stats.history.today && stats.history.today.length > 1) { // Додано перевірку
              const today = stats.history.today;

              const baseDate = new Date();
              let baseDatePlusAvailable = new Date();
              let baseDatePluesUnavailable = new Date();

              today.forEach(({ start, end, isEnabled }, i) => {
                 // Додаємо перевірку на start/end
                 if (!start || !end) return;
                const s =
                  i === 0
                    ? convertToTimeZone(start, { timeZone: place.timezone })
                    : start;
                const e =
                  i === today.length - 1
                    ? convertToTimeZone(end, { timeZone: place.timezone })
                    : end;
                 // Виправлено: різниця має бути між end та start, і обережно з типами
                let durationInMinutes = 0;
                 try {
                   durationInMinutes = Math.abs(differenceInMinutes(new Date(e), new Date(s)));
                 } catch (diffError) {
                   this.logger.error(`Error calculating differenceInMinutes for today stats: ${diffError}`);
                   return; // Пропускаємо цей запис
                 }

                if (isEnabled) {
                  baseDatePlusAvailable = addMinutes(
                    baseDatePlusAvailable,
                    durationInMinutes
                  );
                } else {
                  baseDatePluesUnavailable = addMinutes(
                    baseDatePluesUnavailable,
                    durationInMinutes
                  );
                }
              });

              const howLongAvailable = formatDistance(
                baseDate, // Змінено порядок аргументів
                baseDatePlusAvailable,
                { locale: uk, includeSeconds: false }
              );
              const howLongUnavailable = formatDistance(
                baseDate, // Змінено порядок аргументів
                baseDatePluesUnavailable,
                { locale: uk, includeSeconds: false }
              );

              response = `${response}\nЗі світлом: ${howLongAvailable}\nБез світла: ${howLongUnavailable}`;

              today.forEach(({ start, end, isEnabled }, i) => {
                 // Додаємо перевірку на start/end
                 if (!start || !end) return;
                const emoji = isEnabled ? EMOJ_BULB : EMOJ_MOON;
                const s = format(new Date(start), 'HH:mm', { locale: uk }); // Додано new Date()
                const e = format(new Date(end), 'HH:mm', { locale: uk });   // Додано new Date()
                const duration = formatDistance(new Date(end), new Date(start), { // Додано new Date()
                  locale: uk,
                  includeSeconds: false,
                });
                const entry =
                  i === 0
                    ? `${emoji} до ${e}`
                    : i === today.length - 1
                    ? `${emoji} з ${s}`
                    : `${emoji} ${s}-${e} (${duration})`;

                response = `${response}\n${entry}`;
              });
            } else {
              response += stats.lastStateBeforeToday
                ? ' постійно зі світлом'
                : ' взагалі без світла';
            }
          }

          if (response === '') {
            response = 'Наразі інформація відсутня.';
          }

          response += `\n\n${MSG_DISABLED_REGULAR_SUFFIX}`;

          await telegramBot.sendMessage(msg.chat.id, response, {
            parse_mode: 'HTML',
          });
          this.logger.log(`Sent /stats response to chat ${msg.chat.id}`); // Лог відправки
       } catch (error) {
          this.logger.error(`Error in handleStatsCommand for chat ${msg.chat.id}: ${error}`, error instanceof Error ? error.stack : undefined); // Лог помилки
       }
  }
  private async composePlaceMonthStatsMessage(params: {
    readonly place: Place;
    readonly dateFromTargetMonth: Date;
  }): Promise<string> {
      this.logger.log(`Composing monthly stats message for place ${params.place.id}`); // Лог
      try { // Додано try...catch
          const monthStats =
            await this.electricityAvailabilityService.getMonthStats(params);
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

  private async notifyAllPlaceSubscribersAboutElectricityAvailabilityChange(params: {
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
        response = latest.isAvailable
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

        if (latest.isAvailable) {
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
