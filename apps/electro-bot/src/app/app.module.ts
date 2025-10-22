// ----- КОД "ПІСЛЯ" (ВСТАВТЕ ЦЕЙ КОД) -----
import { BotModule } from '@electrobot/bot';
import { ElectricityAvailabilityModule } from '@electrobot/electricity-availability';
import { Module } from '@nestjs/common';
// ScheduleModule видалено
import { KnexModule } from 'nestjs-knex';
import { CronService } from './cron.service';
// KyivElectricScheduleModule видалено

@Module({
  imports: [
    ElectricityAvailabilityModule, // Це модуль, який пінгує ваш IP
    BotModule,
    // ScheduleModule.forRoot() видалено
    // KyivElectricScheduleModule видалено
    KnexModule.forRoot({
      config: {
        client: 'pg',
        connection: process.env.DATABASE_URL, // Цей рядок правильний
      },
    }),
  ],
  providers: [CronService],
})
export class AppModule {}
