// ----- КОД "ПІСЛЯ" (ВСТАВТЕ ЦЕЙ КОД) -----
import { BotModule } from '@electrobot/bot';
import { ElectricityAvailabilityModule } from '@electrobot/electricity-availability';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { KnexModule } from 'nestjs-knex';
import { CronService } from './cron.service';
// KyivElectricScheduleModule видалено

@Module({
  imports: [
    ElectricityAvailabilityModule, // Це модуль, який пінгує ваш IP
    BotModule,
    ScheduleModule.forRoot() 
    // KyivElectricScheduleModule видалено
  KnexModule.forRoot({
  config: {
    client: 'pg',
    connection: process.env.DATABASE_URL + '?ssl=true', // <-- Додаємо ?ssl=true до URL
    // --- Додаємо цей об'єкт ---
    /* Або спробуйте так, якщо '?ssl=true' не спрацює для Knex:
    connection: {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Дозволяє самопідписані сертифікати (часто потрібно для хмарних БД)
    },
    */
   // --------------------------
  },
}),
  ],
  providers: [CronService],
})
export class AppModule {}
