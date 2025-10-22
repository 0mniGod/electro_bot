// ----- КОД "ПІСЛЯ" (ВСТАВТЕ ЦЕЙ КОД) -----
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import * as TelegramBot from 'node-telegram-bot-api';
import { getBotToken } from 'nestjs-telegraf'; // Ми використаємо цю функцію, хоча залежність може бути іншою

// Шлях для вебхука (можна змінити, але має збігатися з налаштуванням Telegram)
const WEBHOOK_PATH = `/api/webhook`;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Додаємо middleware для обробки JSON-запитів від Telegram
  app.useBodyParser('json', { limit: '50mb' }); // Важливо для отримання Update об'єктів

  // Отримуємо екземпляр бота (це може потребувати адаптації залежно від того, як BotModule зареєстрований)
  // Спроба отримати токен з env, щоб створити інстанс для налаштування вебхука
  const botToken = process.env.BOT_TOKEN;
  if (!botToken) {
    Logger.error('BOT_TOKEN environment variable not set!', 'Bootstrap');
    return; // Зупиняємо, якщо токена немає
  }
  const bot = new TelegramBot(botToken); // Створюємо тимчасовий інстанс ТІЛЬКИ для налаштування вебхука

  // Отримуємо публічний URL з Render (переконайтесь, що APP_URL встановлено в Environment Variables!)
  const appUrl = process.env.APP_URL;
  if (!appUrl) {
    Logger.error('APP_URL environment variable not set!', 'Bootstrap');
    return; // Зупиняємо, якщо URL немає
  }
  const webhookUrl = `${appUrl}${WEBHOOK_PATH}`;

  // Встановлюємо вебхук у Telegram
  try {
    await bot.setWebhook(webhookUrl);
    Logger.log(`Webhook set to ${webhookUrl}`, 'Bootstrap');
  } catch (error) {
    Logger.error(`Failed to set webhook: ${error}`, 'Bootstrap');
  }

  // Додаємо слухача для POST запитів на наш шлях вебхука
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.post(WEBHOOK_PATH, (req, res) => {
    // Отримуємо сервіс бота з NestJS контейнера
    // УВАГА: Нам потрібен спосіб отримати основний інстанс бота, який використовується в NotificationBotService
    // Це може потребувати рефакторингу BotModule або NotificationBotService
    // Поки що припустимо, що ми можемо отримати його так (ЦЕ ТРЕБА АДАПТУВАТИ!)
    try {
       const notificationBotService = app.get('NotificationBotService'); // Припускаємо, що сервіс має такий токен/назву
       const mainBotInstance = notificationBotService.getMainTelegramBotInstance(); // Потрібно додати метод для отримання інстансу
       if (mainBotInstance) {
          mainBotInstance.processUpdate(req.body);
          res.sendStatus(200); // Повідомляємо Telegram, що все ок
       } else {
          Logger.error('Could not get main bot instance to process update', 'Webhook');
          res.sendStatus(500);
       }
    } catch(error) {
       Logger.error(`Error processing webhook update: ${error}`, 'Webhook');
       res.sendStatus(500);
    }
  });


  // Запускаємо веб-сервер
  const port = process.env.PORT || 3000;
  await app.listen(port);
  Logger.log(`🚀 Application is running on port ${port}`, 'Bootstrap');
}

bootstrap();

// Потрібно буде додати метод в NotificationBotService, щоб отримати інстанс бота:
// Наприклад, в libs/bot/src/lib/notification-bot.service.ts:
// public getMainTelegramBotInstance(): TelegramBot | undefined {
//   // Припускаємо, що placeId вашого основного бота відомий або береться з конфігурації
//   const mainPlaceId = 'your-main-place-id'; // Замініть на реальний ID
//   return this.placeBots[mainPlaceId]?.telegramBot;
// }
