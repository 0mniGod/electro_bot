import { BotModule } from '@electrobot/bot';
import { ElectricityAvailabilityModule } from '@electrobot/electricity-availability';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule'; // <-- РОЗКОМЕНТОВАНО
import { KnexModule } from 'nestjs-knex';
import { CronService } from './cron.service';
// KyivElectricScheduleModule видалено з імпортів

@Module({ 
  imports: [
    ElectricityAvailabilityModule,
    BotModule,
    ScheduleModule.forRoot(), // <-- РОЗКОМЕНТОВАНО
    // KyivElectricScheduleModule видалено зі списку imports
    KnexModule.forRoot({
      config: {
        client: 'pg',
        connection: process.env.DATABASE_URL + '?ssl=true', // Додано ?ssl=true
      },
    }),
  ],
  providers: [CronService],
})
export class AppModule {}
