// ----- КОД "ПІСЛЯ" (СПРОЩЕНИЙ) -----
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { NotificationBotService } from '@electrobot/bot'; // <-- Імпортуємо сервіс
import * as bodyParser from 'body-parser'; // <-- Імпортуємо body-parser

// Шлях для вебхука
const WEBHOOK_PATH = `/api/webhook`; // Цей шлях ми вкажемо Telegram вручну

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Додаємо middleware для обробки JSON-запитів від Telegram
  app.use(bodyParser.json()); // Використовуємо імпортований body-parser

  // Отримуємо екземпляр NotificationBotService після ініціалізації NestJS
  const notificationBotService = app.get(NotificationBotService);

  // Додаємо слухача для POST запитів на наш шлях вебхука
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.post(WEBHOOK_PATH, (req, res) => {
    try {
      // Отримуємо основний інстанс бота з сервісу
      const mainBotInstance = notificationBotService.getMainTelegramBotInstance(); // Викликаємо метод, який ми додамо
      if (mainBotInstance) {
         mainBotInstance.processUpdate(req.body); // Передаємо оновлення боту
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
  // Ми більше не намагаємося встановити вебхук тут
}

bootstrap();
