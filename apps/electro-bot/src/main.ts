import { Logger, ValidationPipe } from '@nestjs/common'; // <-- ЗМІНЕНО ІМПОРТИ
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';

// --- ВИДАЛЕНО ВСІ ЗАЙВІ ІМПОРТИ ТА КОНСТАНТИ ---

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // --- ДОДАЄМО ГЛОБАЛЬНИЙ PIPE ---
  // Це необхідно, щоб наш WebhookController
  // міг автоматично валідувати вхідні дані (DTO)
  app.useGlobalPipes(new ValidationPipe());
  // --- ------------------------- ---

  // Запускаємо веб-сервер
  const port = process.env.PORT || 3000;
  await app.listen(port);
  Logger.log(`🚀 Application is running on port ${port}`, 'Bootstrap');
}

bootstrap();
