import { BotModule } from '@electrobot/bot';
import { ElectricityAvailabilityModule } from '@electrobot/electricity-availability';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [
    ElectricityAvailabilityModule,
    BotModule,
    ScheduleModule.forRoot(),
  ],
  providers: [],
})
export class AppModule { }
