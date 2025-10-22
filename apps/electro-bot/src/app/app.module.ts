// ----- ЦЕЙ КОД "ПІСЛЯ" (ВСТАВТЕ ЦЕ) -----
import { BotModule } from '@electrobot/bot';
import { ElectricityAvailabilityModule } from '@electrobot/electricity-availability';
import { Module } from '@nestjs/common';
import { KnexModule } from 'nestjs-knex';
import { CronService } from './cron.service';
// KyivElectricScheduleModule ТА ScheduleModule ВИДАЛЕНІ - ВОНИ БУЛИ ЗЛАМАНІ

@Module({
  imports: [
    ElectricityAvailabilityModule, // Це модуль, який пінгує ваш IP
    BotModule,
    // KyivElectricScheduleModule ТА ScheduleModule ВИДАЛЕНІ
    KnexModule.forRoot({
      config: {
        client: 'pg',
        // Ми замінили старий об'єкт connection на цей рядок:
        connection: process.env.DATABASE_URL,
      },
    }),
  ],
  providers: [CronService],
})
export class AppModule {}
