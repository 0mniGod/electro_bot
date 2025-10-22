// ----- КОД "ПІСЛЯ" (ВСТАВТЕ ЦЕЙ КОД) -----
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';

async function bootstrap() {
  // Змінюємо createApplicationContext на create
  const app = await NestFactory.create(AppModule);

  // Додаємо слухача порту
  const port = process.env.PORT || 3000; // Render надає змінну PORT
  await app.listen(port);

  Logger.log( `🚀 Application is running on port ${port}`);
}

bootstrap();
