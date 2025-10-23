import { Module } from '@nestjs/common';
import { PlaceRepoModule } from '@electrobot/place-repo';
import { UserRepoModule } from '@electrobot/user-repo';
import { NotificationBotService } from './notification-bot.service';
import { ElectricityAvailabilityModule } from '@electrobot/electricity-availability'; // <-- ДОДАЙТЕ ЦЕЙ ІМПОРТ

@Module({
  imports: [
    UserRepoModule,
    PlaceRepoModule,
    ElectricityAvailabilityModule, // <-- ДОДАЙТЕ ЦЕЙ МОДУЛЬ
  ],
  providers: [NotificationBotService],
  exports: [NotificationBotService],
})
export class BotModule {}
