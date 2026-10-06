import { Routes } from 'discord.js';

export function guildCommandRoute(applicationId:string,guildId:string){
  if(!/^\d{17,20}$/.test(applicationId)) throw new Error('DISCORD_APPLICATION_ID must be a Discord snowflake ID.');
  if(!/^\d{17,20}$/.test(guildId)) throw new Error('DISCORD_GUILD_ID must be a Discord snowflake ID.');
  return Routes.applicationGuildCommands(applicationId,guildId);
}
