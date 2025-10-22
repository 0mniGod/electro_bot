import {
  ElectricityAvailabilityService,
  // KyivElectricstatusScheduleService,
} from '@electrobot/electricity-availability';
import { UserRepository } from '@electrobot/user-repo';
import { Injectable, Logger } from '@nestjs/common';
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
export class NotificationBotService {
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
    // private readonly kyivElectricstatusScheduleService: KyivElectricstatusScheduleService,
    private readonly userRepository: UserRepository,
    private readonly placeRepository: PlaceRepository
  ) {
    this.refreshAllPlacesAndBots();

    const refreshRate = 10 * 60 * 1000; // 10 min

    setInterval(() => this.refreshAllPlacesAndBots(), refreshRate);

    this.electricityAvailabilityService.availabilityChange$.subscribe(
      ({ placeId }) => {
        this.notifyAllPlaceSubscribersAboutElectricityAvailabilityChange({
          placeId,
        });
      }
    );
  }

  private async handleCurrentCommand(params: {
    readonly msg: TelegramBot.Message;
    readonly place: Place;
    readonly bot: Bot;
    readonly telegramBot: TelegramBot;
  }): Promise<void> {
    const { msg, place, telegramBot } = params;

    if (this.isGroup({ chatId: msg.chat.id })) return;

    if (place.isDisabled) {
      await this.notifyBotDisabled({ chatId: msg.chat.id, telegramBot });
      return;
    }

    await this.userRepository.saveUserAction({
      placeId: place.id,
      chatId: msg.chat.id,
      command: 'current',
    });

    const [latest] =
      await this.electricityAvailabilityService.getLatestPlaceAvailability({
        placeId: place.id,
        limit: 1,
      });

    if (!latest) {
      await telegramBot.sendMessage(
        msg.chat.id,
        RESP_NO_CURRENT_INFO({ place: place.name }),
        { parse_mode: 'HTML' }
      );
      return;
    }

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

    // Якщо колись потрібно повернути логіку для розкладу — сюди.
    // Зараз просто залишаємо пусті змінні.

    const response = latest.isAvailable
      ? RESP_CURRENTLY_AVAILABLE({
          when,
          howLong,
          place: place.name,
          scheduleDisableMoment,
          schedulePossibleDisableMoment,
        })
      : RESP_CURRENTLY_UNAVAILABLE({
          when,
          howLong,
          place: place.name,
          scheduleEnableMoment,
          schedulePossibleEnableMoment,
        });

    await telegramBot.sendMessage(msg.chat.id, response, {
      parse_mode: 'HTML',
    });
  }

  private async notifyAllPlaceSubscribersAboutElectricityAvailabilityChange(params: {
    readonly placeId: string;
  }): Promise<void> {
    const { placeId } = params;
    const place = this.places[placeId];
    if (!place || place.isDisabled) return;

    const [latest, previous] =
      await this.electricityAvailabilityService.getLatestPlaceAvailability({
        placeId,
        limit: 2,
      });

    if (!latest) return;

    const latestTime = convertToTimeZone(latest.time, {
      timeZone: place.timezone,
    });
    const when = format(latestTime, 'HH:mm dd.MM', { locale: uk });

    let response: string;
    if (!previous) {
      response = latest.isAvailable
        ? RESP_ENABLED_SHORT({ when, place: place.name })
        : RESP_DISABLED_SHORT({ when, place: place.name });
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

      response = latest.isAvailable
        ? diffInMinutes <= MIN_SUSPICIOUS_DISABLE_TIME_IN_MINUTES
          ? RESP_ENABLED_SUSPICIOUS({ when, place: place.name })
          : RESP_ENABLED_DETAILED({ when, howLong, place: place.name })
        : diffInMinutes <= MIN_SUSPICIOUS_DISABLE_TIME_IN_MINUTES
        ? RESP_DISABLED_SUSPICIOUS({ when, place: place.name })
        : RESP_DISABLED_DETAILED({ when, howLong, place: place.name });
    }

    this.notifyAllPlaceSubscribers({ place, msg: response });
  }

  private async notifyAllPlaceSubscribers(params: {
    readonly place: Place;
    readonly msg: string;
  }): Promise<void> {
    const { place, msg } = params;
    const botEntry = this.placeBots[place.id];
    if (!botEntry || !botEntry.bot.isEnabled) return;

    const subscribers = await
