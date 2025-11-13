import { Module } from '@nestjs/common';
import { PlaceRepoModule } from '@electrobot/place-repo';
import { UserRepoModule } from '@electrobot/user-repo';
import { NotificationBotService } from './notification-bot.service';
import { ElectricityAvailabilityModule } from '@electrobot/electricity-availability'; 
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [
    //UserRepoModule,
    //PlaceRepoModule,
    ScheduleModule.forRoot(),
    ElectricityAvailabilityModule, // <-- ДОДАЙТЕ ЦЕЙ МОДУЛЬ
  ],
  providers: [NotificationBotService],
  exports: [NotificationBotService],
})
export class BotModule {}
