import * as emoji from 'node-emoji';
import { VERSION } from '@electrobot/domain';
import { format } from 'date-fns';

export const EMOJ_UA = emoji.get('flag-ua');
export const EMOJ_PERSERVE = emoji.get('persevere');
export const EMOJ_BULB = emoji.get('bulb'); // 💡
export const EMOJ_MOON = emoji.get('new_moon_with_face'); // 🌚
export const EMOJ_HALF_MOON = emoji.get('waning_crescent_moon');
export const EMOJ_KISS = emoji.get('kiss');
export const EMOJ_KISS_HEART = emoji.get('kissing_heart');
export const EMOJ_HEART = emoji.get('heart');
export const EMOJ_SLOT_MACHINE = emoji.get('slot_machine');
export const EMOJ_CRYSTAL_BALL = emoji.get('crystal_ball');
export const EMOJ_GAME_DIE = emoji.get('game_die');
export const EMOJ_CROSSED_FINGERS = emoji.get('crossed_fingers');
export const EMOJ_SYMBOLS_OVER_MOUTH = emoji.get('symbols_over_mouth');

// --- ДОДАНО НОВІ ЕМОДЗІ ДЛЯ ГРАФІКА ---
export const EMOJ_CHECK_MARK = emoji.get('white_check_mark'); // ✅ (Минулий)
export const EMOJ_GREEN_CIRCLE = emoji.get('white_check_mark'); // 🟢 (Поточний)
export const EMOJ_HOURGLASS = emoji.get('hourglass_flowing_sand'); // ⏳ (Майбутній гарантований)
export const EMOJ_GRAY_Q = emoji.get('grey_question'); // ❔ (Майбутній можливий / "сіра зона")
// --- --------------------------------- ---


export const MSG_DISABLED_REGULAR_SUFFIX =
  'Не забувай підтримувати українську армію!\n';

export const MSG_LAUNCH_DOC_LINK =
  '<a href="https://zd333.github.io/electro_bot/doc/launch-bot-for-my-place.html">Як ти можеш запустити такого бота для власної локації без всякого програмування</a>';

export const RESP_START = (params: {
  readonly place: string;
  readonly listedBotsMessage: string;
}) =>
  `Привіт! Цей бот допомогає моніторити ситуацію зі світлом (електроенергією) в ${params.place}.\n\n` +
  `За допомогою команди /current ти завжди можеш дізнатися чи є зараз на локації світло і як довго це триває.\n\n` +
  `Команда /subscribe дозволяє підписатися на сповіщення щодо зміни ситуації (відключення/включення).\n\n` +
  `За допомогою команди /stats можна переглянути статистику (звіт по включенням/` +
  `відключенням за поточну і попередню добу, сумарний час наявності/відсутності світла).\n\n` +
  `Контроль наявності світла відбувається за допомогою перевірки Інтернет зв‘язку з провайдером ${params.place}. Зауваж, що в разі проблем з Інтернетом бот може видавати невірну інформацію.\n\n` +
  `Бота створено @oleksandr_changli, реанімовано @OmniGod\n\n` +
  params.listedBotsMessage +
  `    `;
export const RESP_NO_CURRENT_INFO = (params: { readonly place: string }) =>
  `Нажаль, наразі інформація щодо наявності світла в ${params.place} відсутня.`;

export const TODAYS_SCHEDULE = (params: {
  readonly scheduleString?: string;
}) =>
  params.scheduleString && params.scheduleString.length > 0
    ? `\n\n<b>--- Графік на сьогодні ---</b>\n${params.scheduleString}`
    : '';

export const TOMORROWS_SCHEDULE = (params: {
  readonly scheduleString?: string; // Повний графік на завтра
}) =>
  params.scheduleString && params.scheduleString.length > 0
    ? `\n\n<b>--- Графік на завтра ---</b>\n${params.scheduleString}`
    : '';

export const RESP_CURRENTLY_AVAILABLE = (params: {
  readonly when: string;
  readonly howLong: string;
  readonly place: string;
  readonly scheduleDisableMoment?: Date;
  readonly tomorrowsSchedule?: string;
  readonly schedulePossibleDisableMoment?: Date;
  readonly todaysSchedule?: string;
  readonly scheduleContextMessage?: string;
}) =>
  `${EMOJ_BULB} Наразі все добре - світло в ${params.place} є!\n\n` +
  `Включення відбулося ${params.when}.\n` +
  `Світло є вже ${params.howLong}.\n` +
  EXPECTED_DISABLE_MOMENT({
    scheduleDisableMoment: params.scheduleDisableMoment,
    schedulePossibleDisableMoment: params.schedulePossibleDisableMoment,
  }) +
  `\n${params.scheduleContextMessage || ''}` +
  TODAYS_SCHEDULE({ scheduleString: params.todaysSchedule }) +
  TOMORROWS_SCHEDULE({ scheduleString: params.tomorrowsSchedule }) +
  `\nСлава Україні!`;

export const RESP_CURRENTLY_UNAVAILABLE = (params: {
  readonly when: string;
  readonly howLong: string;
  readonly place: string;
  readonly tomorrowsSchedule?: string;
  readonly scheduleEnableMoment?: Date;
  readonly schedulePossibleEnableMoment?: Date;
  readonly todaysSchedule?: string;
  readonly scheduleContextMessage?: string;
}) =>
  `${EMOJ_MOON} Нажаль, наразі світла в ${params.place} нема.\n\n` +
  `Вимкнення відбулося ${params.when}.\n` +
  `Світло відсутнє вже ${params.howLong}.\n` +
  EXPECTED_ENABLE_MOMENT({
    scheduleEnableMoment: params.scheduleEnableMoment,
    schedulePossibleEnableMoment: params.schedulePossibleEnableMoment,
  }) +
  `\n${params.scheduleContextMessage || ''}` +
  TODAYS_SCHEDULE({ scheduleString: params.todaysSchedule }) +
  TOMORROWS_SCHEDULE({ scheduleString: params.tomorrowsSchedule }) +
  `\n${MSG_DISABLED_REGULAR_SUFFIX}`;

export const RESP_SUBSCRIPTION_CREATED = (params: { readonly place: string }) =>
  `Підписка створена - ти будеш отримувати повідомлення кожного разу після зміни ситуації зі світлом в ${params.place}.\n` +
  `Ти завжди можеш відписатися за допомогою команди /unsubscribe.`;
export const RESP_SUBSCRIPTION_ALREADY_EXISTS = (params: {
  readonly place: string;
}) =>
  `Підписка вже створена і ти вже отримуєш повідомлення кожного разу після зміни ситуації зі світлом в ${params.place}.\n` +
  `Ти завжди можеш відписатися за допомогою команди /unsubscribe.`;
export const RESP_UNSUBSCRIBED = (params: { readonly place: string }) =>
  `Підписка скасована - ти більше не будеш отримувати повідомлення щодо зміни ситуації зі світлом в ${params.place}.`;
export const RESP_WAS_NOT_SUBSCRIBED = (params: { readonly place: string }) =>
  `Підписка і так відсутня, ти зараз не отримуєш повідомлення щодо зміни ситуації зі світлом в ${params.place}.`;
export const RESP_ABOUT = (params: { readonly listedBotsMessage: string }) =>
  `Версія ${VERSION}\n\n` +
  `Бота створено @oleksandr_changli, реанімовано @OmniGod\n\n` +
  params.listedBotsMessage +
  `Якщо тобі подобається цей бот - можеш подякувати донатом на підтримку української армії .\n\n`;

// --- ОНОВЛЕНІ СПОВІЩЕННЯ (додано scheduleContextMessage) ---

export const RESP_ENABLED_SHORT = (params: {
  readonly when: string;
  readonly place: string;
  readonly scheduleDisableMoment?: Date;
  readonly schedulePossibleDisableMoment?: Date;
  readonly scheduleContextMessage?: string;
  readonly todaysSchedule?: string; // <--- ДОДАНО
  readonly tomorrowsSchedule?: string; // <--- ДОДАНО
}) =>
  `${EMOJ_BULB} ${params.when}\nЮхууу, світло в ${params.place} включили!\n` +
  EXPECTED_DISABLE_MOMENT({
    scheduleDisableMoment: params.scheduleDisableMoment,
    schedulePossibleDisableMoment: params.schedulePossibleDisableMoment,
  }) +
  `\n${params.scheduleContextMessage || ''}` +
  TODAYS_SCHEDULE({ scheduleString: params.todaysSchedule }) + // <--- ДОДАНО
  TOMORROWS_SCHEDULE({ scheduleString: params.tomorrowsSchedule }) + // <--- ДОДАНО
  `\nСлава Україні!    `;

export const RESP_DISABLED_SHORT = (params: {
  readonly when: string;
  readonly place: string;
  readonly scheduleEnableMoment?: Date;
  readonly schedulePossibleEnableMoment?: Date;
  readonly scheduleContextMessage?: string;
  readonly todaysSchedule?: string; // <--- ДОДАНО
  readonly tomorrowsSchedule?: string; // <--- ДОДАНО
}) =>
  `${EMOJ_MOON} ${params.when}\nЙой, світло в ${params.place} вимкнено!\n` +
  EXPECTED_ENABLE_MOMENT({
    scheduleEnableMoment: params.scheduleEnableMoment,
    schedulePossibleEnableMoment: params.schedulePossibleEnableMoment,
  }) +
  `\n${params.scheduleContextMessage || ''}` +
  TODAYS_SCHEDULE({ scheduleString: params.todaysSchedule }) + // <--- ДОДАНО
  TOMORROWS_SCHEDULE({ scheduleString: params.tomorrowsSchedule }) + // <--- ДОДАНО
  `\n${MSG_DISABLED_REGULAR_SUFFIX}`;

export const RESP_ENABLED_DETAILED = (params: {
  readonly when: string;
  readonly howLong: string;
  readonly place: string;
  readonly scheduleDisableMoment?: Date;
  readonly schedulePossibleDisableMoment?: Date;
  readonly scheduleContextMessage?: string;
  readonly todaysSchedule?: string; // <--- ДОДАНО
  readonly tomorrowsSchedule?: string; // <--- ДОДАНО
}) =>
  `${EMOJ_BULB} ${params.when}\nЮхууу, світло в ${params.place} включили!\n` +
  `Світло було відсутнє ${params.howLong}.\n` +
  EXPECTED_DISABLE_MOMENT({
    scheduleDisableMoment: params.scheduleDisableMoment,
    schedulePossibleDisableMoment: params.schedulePossibleDisableMoment,
  }) +
  `\n${params.scheduleContextMessage || ''}` +
  TODAYS_SCHEDULE({ scheduleString: params.todaysSchedule }) + // <--- ДОДАНО
  TOMORROWS_SCHEDULE({ scheduleString: params.tomorrowsSchedule }) + // <--- ДОДАНО
  `\nСлава Україні!    `;

export const RESP_ENABLED_SUSPICIOUS = (params: {
  readonly when: string;
  readonly place: string;
  readonly scheduleContextMessage?: string;
  readonly todaysSchedule?: string; // <--- ДОДАНО
  readonly tomorrowsSchedule?: string; // <--- ДОДАНО
}) =>
  `${EMOJ_BULB} ${params.when}\nСхоже, що, світло в ${params.place} включили!\n` +
  `Хоча можливо його і не виключали, а це насправді була проблема з Інтернетом ${EMOJ_PERSERVE}.` +
  `\n${params.scheduleContextMessage || ''}` +
  TODAYS_SCHEDULE({ scheduleString: params.todaysSchedule }) + // <--- ДОДАНО
  TOMORROWS_SCHEDULE({ scheduleString: params.tomorrowsSchedule }); // <--- ДОДАНО

export const RESP_DISABLED_DETAILED = (params: {
  readonly when: string;
  readonly howLong: string;
  readonly place: string;
  readonly scheduleEnableMoment?: Date;
  readonly schedulePossibleEnableMoment?: Date;
  readonly scheduleContextMessage?: string;
  readonly todaysSchedule?: string; // <--- ДОДАНО
  readonly tomorrowsSchedule?: string; // <--- ДОДАНО
}) =>
  `${EMOJ_MOON} ${params.when}\nЙой, світло в ${params.place} вимкнено!\n` +
  `Ми насолоджувалися світлом ${params.howLong}.\n` +
  EXPECTED_ENABLE_MOMENT({
    scheduleEnableMoment: params.scheduleEnableMoment,
    schedulePossibleEnableMoment: params.schedulePossibleEnableMoment,
  }) +
  `\n${params.scheduleContextMessage || ''}` +
  TODAYS_SCHEDULE({ scheduleString: params.todaysSchedule }) + // <--- ДОДАНО
  TOMORROWS_SCHEDULE({ scheduleString: params.tomorrowsSchedule }) + // <--- ДОДАНО
  `\n${MSG_DISABLED_REGULAR_SUFFIX}`;

export const RESP_DISABLED_SUSPICIOUS = (params: {
  readonly when: string;
  readonly place: string;
  readonly scheduleContextMessage?: string;
  readonly todaysSchedule?: string; // <--- ДОДАНО
  readonly tomorrowsSchedule?: string; // <--- ДОДАНО
}) =>
  `${EMOJ_HALF_MOON} ${params.when}\nКарамба, можливо світло в ${params.place} вимкнено!\n\n` +
  `Хоча це може бути просто проблема з Інтернетом і світло насправді не вимикали ${EMOJ_PERSERVE}.` +
  `\n${params.scheduleContextMessage || ''}` +
  TODAYS_SCHEDULE({ scheduleString: params.todaysSchedule }) + // <--- ДОДАНО
  TOMORROWS_SCHEDULE({ scheduleString: params.tomorrowsSchedule }); // <--- ДОДАНО

// --- (Решта файлу: RESP_PREVIOUS_MONTH_SUMMARY, MSG_DISABLED, EXPECTED_... залишаються без змін) ---

export const RESP_PREVIOUS_MONTH_SUMMARY = (params: {
  readonly statsMessage: string;
}) =>
  `${EMOJ_HALF_MOON}Привіт, на зв‘язку світлобот!\n\n` +
  `Ось і закінчився черговий місяць, в якому електрика і світло мають для нас особливе значення.\n\n` +
  params.statsMessage +
  '\n\n' +
  `Не сумуй, що час пролетів так швидко, адже тепер ми на місяць ближче до Перемоги!\n\n` +
  `Посміхайся, радій життю та не забувай підтримувати Українську Армію${EMOJ_HEART}!\n\n` +
  `${EMOJ_KISS_HEART}${EMOJ_KISS_HEART}${EMOJ_KISS_HEART}\n` +
  `    `;
export const MSG_DISABLED =
  'Бот відключено адміністратором, зверніться до власника бота.\n';
export const EXPECTED_ENABLE_MOMENT = (params: {
  readonly scheduleEnableMoment?: Date;
  readonly schedulePossibleEnableMoment?: Date;
}) =>
  // 1. Пріоритет - ГАРАНТОВАНЕ включення.
  params.scheduleEnableMoment
    ? `\nЗгідно графіка очікуємо на включення о ${format(
      params.scheduleEnableMoment,
      'HH:mm'
    )}.\n`
    // 2. Якщо його нема, але є "можливе" - показуємо "можливе".
    : params.schedulePossibleEnableMoment
      ? `\nЗгідно графіка очікуємо на можливе включення о ${format(
        params.schedulePossibleEnableMoment,
        'HH:mm'
      )} (сіра зона).\n`
      // 3. Інакше нічого не показуємо.
      : '';
export const EXPECTED_DISABLE_MOMENT = (params: {
  readonly scheduleDisableMoment?: Date;
  readonly schedulePossibleDisableMoment?: Date;
}) =>
  // 1. Пріоритет - ГАРАНТОВАНЕ вимкнення.
  params.scheduleDisableMoment
    ? `\nЗгідно графіка очікуємо на вимкнення о ${format(
      params.scheduleDisableMoment,
      'HH:mm'
    )}.\n`
    // 2. Якщо його нема, але є "можливе" - показуємо "можливе".
    : params.schedulePossibleDisableMoment
      ? `\nЗгідно графіка очікуємо на можливе вимкнення о ${format(
        params.schedulePossibleDisableMoment,
        'HH:mm'
      )} (сіра зона).\n`
      // 3. Інакше нічого не показуємо.
      : '';
