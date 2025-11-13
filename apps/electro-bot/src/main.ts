import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { NotificationBotService } from '@electrobot/bot'; // <-- ДОДАЙТЕ ЦЕЙ ІМПОРТ
import * as bodyParser from 'body-parser'; // <-- ДОДАЙТЕ ЦЕЙ ІМПОРТ

// Шлях для вебхука Telegram (не плутати з /webhook/telegram-channel для Pipedream)
// Це адреса, на яку Telegram буде надсилати команди /start, /current тощо.
const TELEGRAM_WEBHOOK_PATH = `/api/telegram-updates`; // Ви можете обрати будь-який шлях

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(new ValidationPipe());

  // Додаємо middleware для обробки JSON-запитів
  app.use(bodyParser.json()); // <--- ДОДАЙТЕ ЦЕЙ РЯДОК

  // Отримуємо екземпляр NotificationBotService
  const notificationBotService = app.get(NotificationBotService);

  // --- ДОДАЙТЕ ЦЕЙ БЛОК НАЗАД ---
  // Додаємо слухача для POST запитів від Telegram
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.post(TELEGRAM_WEBHOOK_PATH, (req, res) => {
    try {
      // Отримуємо основний інстанс бота
      const mainBotInstance = notificationBotService.getMainTelegramBotInstance();
      
      if (mainBotInstance) {
         // Передаємо оновлення (команду /start, /current) боту
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
  // --- ----------------------- ---

  const port = process.env.PORT || 3000;
  await app.listen(port);
  Logger.log(`🚀 Application is running on port ${port}`, 'Bootstrap');
  Logger.log(`Telegram Webhook listening on ${TELEGRAM_WEBHOOK_PATH}`, 'Bootstrap');
}

bootstrap();
