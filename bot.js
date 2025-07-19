require('dotenv').config();
const Discord = require('discord.js');
const axios = require('axios');
const cron = require('node-cron');

class BaseballBot {
    constructor(token, channelIds) {
        this.client = new Discord.Client({
            intents: [
                Discord.GatewayIntentBits.Guilds,
                Discord.GatewayIntentBits.GuildMessages,
                Discord.GatewayIntentBits.MessageContent
            ]
        });
        this.token = token;
        // Support multiple channel IDs
        this.channelIds = Array.isArray(channelIds) ? channelIds : [channelIds];
        this.currentSeason = new Date().getFullYear();
        
        // Players to monitor - Updated with Pete Alonso and Bryce Harper
        this.players = {
            '592450': { name: 'Aaron Judge', team: 'NYY', number: '99', lastCheckedHR: 0 },
            '665862': { name: 'Jazz Chisholm Jr.', team: 'NYY', number: '13', lastCheckedHR: 0 },
            '665742': { name: 'Juan Soto', team: 'NYM', number: '22', lastCheckedHR: 0 },
            '660271': { name: 'Shohei Ohtani', team: 'LAD', number: '17', lastCheckedHR: 0 },
            '656941': { name: 'Kyle Schwarber', team: 'PHI', number: '12', lastCheckedHR: 0 },
            '660670': { name: 'Ronald Acuña Jr.', team: 'ATL', number: '13', lastCheckedHR: 0 },
            '624413': { name: 'Pete Alonso', team: 'NYM', number: '20', lastCheckedHR: 0 },
            '547180': { name: 'Bryce Harper', team: 'PHI', number: '3', lastCheckedHR: 0 }
        };
        
        // Add debugging flag
        this.debugging = true;
        this.lastCheckTime = null;
    }

    log(message) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] ${message}`);
    }

    async initialize() {
        this.log('Initializing bot...');
        this.log(`Configured to send alerts to ${this.channelIds.length} channel(s): ${this.channelIds.join(', ')}`);
        
        // Initialize home run counts for all players
        for (const playerId of Object.keys(this.players)) {
            const currentHR = await this.getPlayerHomeRuns(playerId);
            this.players[playerId].lastCheckedHR = currentHR;
            this.log(`Initialized ${this.players[playerId].name}: ${currentHR} HRs`);
        }
        
        this.client.on('ready', () => {
            this.log(`Bot logged in as ${this.client.user.tag}`);
            this.startMonitoring();
        });

        this.client.on('error', (error) => {
            this.log(`Discord client error: ${error.message}`);
            console.error('Full error:', error);
        });

        this.client.on('messageCreate', async (message) => {
            if (message.author.bot) return;
            await this.handleCommand(message);
        });

        await this.client.login(this.token);
    }

    async getPlayerStats(playerId) {
        try {
            const response = await axios.get(
                `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=season&season=${this.currentSeason}&group=hitting`
            );
            
            const stats = response.data.stats[0];
            if (stats && stats.splits && stats.splits.length > 0) {
                return stats.splits[0].stat;
            }
            return null;
        } catch (error) {
            this.log(`Error fetching stats for player ${playerId}: ${error.message}`);
            return null;
        }
    }

    async getPlayerHomeRuns(playerId) {
        const stats = await this.getPlayerStats(playerId);
        return stats ? parseInt(stats.homeRuns) || 0 : 0;
    }

    async getRecentHomeRunDetails(playerId) {
        try {
            // Get player's recent games - increased limit to find more recent home runs
            const gamesResponse = await axios.get(
                `https://statsapi.mlb.com/api/v1/people/${playerId}/gameLog?season=${this.currentSeason}&gameType=R&limit=10`
            );
            
            if (!gamesResponse.data.dates || gamesResponse.data.dates.length === 0) {
                return { distance: "Distance not available", rbi: "RBI not available" };
            }

            // Look through recent games for home runs
            for (const date of gamesResponse.data.dates) {
                for (const game of date.games) {
                    try {
                        // Get detailed game data
                        const gameDetailResponse = await axios.get(
                            `https://statsapi.mlb.com/api/v1/game/${game.gameId}/feed/live`
                        );
                        
                        const gameData = gameDetailResponse.data;
                        if (!gameData.liveData || !gameData.liveData.plays || !gameData.liveData.plays.allPlays) {
                            continue;
                        }

                        // Look for home runs by this player
                        const plays = gameData.liveData.plays.allPlays;
                        for (const play of plays.reverse()) { // Start with most recent plays
                            // Enhanced home run detection - check multiple possible event types
                            const isHomeRun = play.result && 
                                (play.result.event === 'Home Run' || 
                                 play.result.eventType === 'home_run' ||
                                 (play.result.description && play.result.description.toLowerCase().includes('home run'))) &&
                                play.matchup && play.matchup.batter && 
                                play.matchup.batter.id.toString() === playerId;
                            
                            if (isHomeRun) {
                                
                                let distance = "Distance not available";
                                let rbi = play.result.rbi || 0;
                                
                                // Try to get distance from multiple possible locations in the API response
                                if (play.hitData && play.hitData.totalDistance) {
                                    distance = `${play.hitData.totalDistance} ft`;
                                } else if (play.hitData && play.hitData.distance) {
                                    distance = `${play.hitData.distance} ft`;
                                } else if (play.result && play.result.description && play.result.description.includes('ft')) {
                                    // Extract distance from description if available
                                    const distanceMatch = play.result.description.match(/(\d+)\s*ft/);
                                    if (distanceMatch) {
                                        distance = `${distanceMatch[1]} ft`;
                                    }
                                } else if (play.result && play.result.distance) {
                                    distance = `${play.result.distance} ft`;
                                } else if (play.result && play.result.trajectory && play.result.trajectory.includes('ft')) {
                                    // Try to extract from trajectory field
                                    const distanceMatch = play.result.trajectory.match(/(\d+)\s*ft/);
                                    if (distanceMatch) {
                                        distance = `${distanceMatch[1]} ft`;
                                    }
                                }
                                
                                // Determine RBI description based on actual RBI count
                                let rbiDescription;
                                if (rbi === 1) {
                                    rbiDescription = "Solo HR";
                                } else if (rbi === 2) {
                                    rbiDescription = "2-run HR";
                                } else if (rbi === 3) {
                                    rbiDescription = "3-run HR";
                                } else if (rbi === 4) {
                                    rbiDescription = "Grand Slam!";
                                } else {
                                    rbiDescription = "Solo HR"; // Default fallback
                                }
                                
                                // Debug logging to understand API structure
                                if (this.debugging) {
                                    this.log(`Found HR for ${playerId}: RBI=${rbi}, Distance=${distance}`);
                                    this.log(`Play result structure: ${JSON.stringify(play.result, null, 2)}`);
                                    if (play.hitData) {
                                        this.log(`Hit data structure: ${JSON.stringify(play.hitData, null, 2)}`);
                                    }
                                }
                                
                                return { 
                                    distance: distance, 
                                    rbi: rbi,
                                    rbiDescription: rbiDescription,
                                    gameId: game.gameId
                                };
                            }
                        }
                    } catch (gameError) {
                        this.log(`Error fetching game ${game.gameId} details: ${gameError.message}`);
                        continue;
                    }
                }
            }
            
            return { distance: "Distance not available", rbi: "RBI not available" };
        } catch (error) {
            this.log(`Error fetching home run details: ${error.message}`);
            return { distance: "Distance not available", rbi: "RBI not available" };
        }
    }

    async getHomeRunDetailsFromAlternativeAPI(playerId) {
        try {
            // Alternative approach: Get recent home runs from player's season stats
            const response = await axios.get(
                `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=gameLog&season=${this.currentSeason}&group=hitting&gameType=R`
            );
            
            if (response.data.stats && response.data.stats[0] && response.data.stats[0].splits) {
                // Look for the most recent game with home runs
                const recentGames = response.data.stats[0].splits
                    .filter(game => game.stat.homeRuns > 0)
                    .sort((a, b) => new Date(b.date) - new Date(a.date));
                
                if (recentGames.length > 0) {
                    const mostRecentHRGame = recentGames[0];
                    return {
                        distance: "Distance not available", // This endpoint doesn't provide distance
                        rbi: mostRecentHRGame.stat.rbi || 1,
                        rbiDescription: this.getRbiDescription(mostRecentHRGame.stat.rbi || 1),
                        gameId: mostRecentHRGame.gameId
                    };
                }
            }
            
            return { distance: "Distance not available", rbi: 1, rbiDescription: "Solo HR" };
        } catch (error) {
            this.log(`Error in alternative HR details API: ${error.message}`);
            return { distance: "Distance not available", rbi: 1, rbiDescription: "Solo HR" };
        }
    }

    getRbiDescription(rbi) {
        if (rbi === 1) return "Solo HR";
        if (rbi === 2) return "2-run HR";
        if (rbi === 3) return "3-run HR";
        if (rbi === 4) return "Grand Slam!";
        return "Solo HR"; // Default fallback
    }

    async checkForNewHomeRuns() {
        this.lastCheckTime = new Date();
        this.log(`Starting home run check at ${this.lastCheckTime.toISOString()}`);
        
        let alertsSent = 0;
        
        for (const [playerId, playerData] of Object.entries(this.players)) {
            try {
                const currentHomeRuns = await this.getPlayerHomeRuns(playerId);
                
                this.log(`${playerData.name}: Current=${currentHomeRuns}, Last=${playerData.lastCheckedHR}`);
                
                if (currentHomeRuns > playerData.lastCheckedHR) {
                    const newHomeRuns = currentHomeRuns - playerData.lastCheckedHR;
                    this.log(`🚨 NEW HOME RUN DETECTED! ${playerData.name} went from ${playerData.lastCheckedHR} to ${currentHomeRuns} (+${newHomeRuns})`);
                    
                    let homeRunDetails = await this.getRecentHomeRunDetails(playerId);
                    
                    // If primary method didn't find details, try alternative API
                    if (homeRunDetails.distance === "Distance not available" && homeRunDetails.rbi === "RBI not available") {
                        this.log(`Primary method failed for ${playerData.name}, trying alternative API...`);
                        homeRunDetails = await this.getHomeRunDetailsFromAlternativeAPI(playerId);
                    }
                    
                    await this.sendHomeRunAlert(playerData, currentHomeRuns, newHomeRuns, homeRunDetails);
                    this.players[playerId].lastCheckedHR = currentHomeRuns;
                    alertsSent++;
                }
            } catch (error) {
                this.log(`Error checking ${playerData.name}: ${error.message}`);
                console.error(`Full error for ${playerData.name}:`, error);
            }
        }
        
        this.log(`Home run check completed. Alerts sent: ${alertsSent}`);
    }

    async sendHomeRunAlert(playerData, totalHomeRuns, newCount, details) {
        this.log(`Sending home run alert for ${playerData.name} to ${this.channelIds.length} channel(s)...`);
        
        // Create the embed once
        const hrType = details.rbiDescription || 'Solo HR';
        const titleText = hrType === 'Grand Slam!' ? 
            `⚾ ${playerData.name.toUpperCase()} GRAND SLAM! ⚾` :
            `⚾ ${playerData.name.toUpperCase()} ${hrType.toUpperCase().replace(' HR', ' HOME RUN')}! ⚾`;
        
        const embed = new Discord.EmbedBuilder()
            .setTitle(titleText)
            .setDescription(`${playerData.name} just hit ${newCount > 1 ? `${newCount} home runs` : 'a home run'}!`)
            .addFields(
                { name: 'Player', value: `${playerData.name} (#${playerData.number})`, inline: true },
                { name: 'Team', value: playerData.team, inline: true },
                { name: 'Season Total', value: `${totalHomeRuns} HR`, inline: true },
                { name: 'Distance', value: details.distance, inline: true }
            )
            .setColor('#132448')
            .setTimestamp();

        // Set player headshot using MLB's official headshot URLs
        const headshots = {
            'Aaron Judge': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/592450/headshot/67/current',
            'Jazz Chisholm Jr.': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/665862/headshot/67/current',
            'Juan Soto': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/665742/headshot/67/current',
            'Shohei Ohtani': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/660271/headshot/67/current',
            'Kyle Schwarber': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/656941/headshot/67/current',
            'Ronald Acuña Jr.': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/660670/headshot/67/current',
            'Pete Alonso': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/624413/headshot/67/current',
            'Bryce Harper': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/547180/headshot/67/current'
        };
        
        if (headshots[playerData.name]) {
            embed.setThumbnail(headshots[playerData.name]);
        }

        // Send to all configured channels
        let successCount = 0;
        for (const channelId of this.channelIds) {
            try {
                const channel = await this.client.channels.fetch(channelId);
                await channel.send({ embeds: [embed] });
                this.log(`✅ Successfully sent alert to channel ${channelId}`);
                successCount++;
            } catch (error) {
                this.log(`❌ Error sending message to channel ${channelId}: ${error.message}`);
                console.error(`Full error for channel ${channelId}:`, error);
            }
        }
        
        this.log(`📊 Alert summary: ${successCount}/${this.channelIds.length} channels notified for ${playerData.name} (Total: ${totalHomeRuns} HR, Distance: ${details.distance})`);
    }

    startMonitoring() {
        // Check every 5 minutes during baseball season (April-October)
        cron.schedule('*/5 * * * *', async () => {
            const now = new Date();
            const month = now.getMonth() + 1;
            
            if (month >= 4 && month <= 10) {
                await this.checkForNewHomeRuns();
            } else {
                this.log('Outside baseball season, skipping check');
            }
        });
        
        this.log('Started monitoring for home runs from your selected star players!');
        this.log('Checking every 5 minutes during baseball season (April-October)');
    }

    async handleCommand(message) {
        const content = message.content.toLowerCase();
        
        // Enhanced commands for all players
        if (content === '!judge') {
            await this.sendPlayerStats('592450', message);
        }
        
        if (content === '!jazz') {
            await this.sendPlayerStats('665862', message);
        }
        
        if (content === '!soto') {
            await this.sendPlayerStats('665742', message);
        }
        
        if (content === '!ohtani') {
            await this.sendPlayerStats('660271', message);
        }
        
        if (content === '!schwarber') {
            await this.sendPlayerStats('656941', message);
        }
        
        if (content === '!acuna') {
            await this.sendPlayerStats('660670', message);
        }
        
        // New commands for Pete Alonso and Bryce Harper
        if (content === '!alonso') {
            await this.sendPlayerStats('624413', message);
        }
        
        if (content === '!harper') {
            await this.sendPlayerStats('547180', message);
        }
        
        // List all tracked players
        if (content === '!players') {
            await this.sendTrackedPlayers(message);
        }
        
        // Show all players' home run totals
        if (content === '!hrstats') {
            await this.sendAllHomeRunStats(message);
        }
        
        // Test home run alert command
        if (content === '!testhr') {
            await this.sendTestHomeRunAlert(message);
        }
        
        // NEW DEBUG COMMANDS
        if (content === '!debug') {
            await this.sendDebugInfo(message);
        }
        
        if (content === '!forcecheck') {
            await message.reply('Running manual home run check...');
            await this.checkForNewHomeRuns();
            await message.reply('Manual check completed! Check console logs for details.');
        }
        
        // Force reset a player's HR count (useful for testing)
        if (content.startsWith('!reset ')) {
            const playerName = content.split(' ')[1];
            await this.resetPlayerHR(playerName, message);
        }
        
        // Test home run details fetching for a specific player
        if (content.startsWith('!testdetails ')) {
            const playerName = content.split(' ')[1];
            await this.testHomeRunDetails(playerName, message);
        }
    }

    async sendDebugInfo(message) {
        try {
            const debugInfo = [];
            debugInfo.push(`**Bot Status:**`);
            debugInfo.push(`- Last check: ${this.lastCheckTime ? this.lastCheckTime.toISOString() : 'Never'}`);
            debugInfo.push(`- Current season: ${this.currentSeason}`);
            debugInfo.push(`- Debugging enabled: ${this.debugging}`);
            debugInfo.push(`- Alert channels: ${this.channelIds.length} (${this.channelIds.join(', ')})`);
            debugInfo.push(`\n**Player Tracking:**`);
            
            for (const [playerId, playerData] of Object.entries(this.players)) {
                const currentHR = await this.getPlayerHomeRuns(playerId);
                debugInfo.push(`- ${playerData.name}: Tracked=${playerData.lastCheckedHR}, Current=${currentHR}`);
            }

            const embed = new Discord.EmbedBuilder()
                .setTitle('🔧 Debug Information')
                .setDescription(debugInfo.join('\n'))
                .setColor('#FFA500')
                .setTimestamp();

            await message.reply({ embeds: [embed] });
        } catch (error) {
            this.log(`Error in debug command: ${error.message}`);
            await message.reply('Error getting debug info!');
        }
    }

    async resetPlayerHR(playerName, message) {
        try {
            const playerId = Object.keys(this.players).find(id => 
                this.players[id].name.toLowerCase().includes(playerName.toLowerCase())
            );
            
            if (!playerId) {
                await message.reply(`Player "${playerName}" not found!`);
                return;
            }
            
            const oldValue = this.players[playerId].lastCheckedHR;
            this.players[playerId].lastCheckedHR = 0;
            this.log(`Reset ${this.players[playerId].name} HR count from ${oldValue} to 0 (manual reset)`);
            
            await message.reply(`Reset ${this.players[playerId].name}'s tracked HR count from ${oldValue} to 0. Next check will detect any current HRs as new.`);
        } catch (error) {
            this.log(`Error in reset command: ${error.message}`);
            await message.reply('Error resetting player HR count!');
        }
    }

    async testHomeRunDetails(playerName, message) {
        try {
            const playerId = Object.keys(this.players).find(id => 
                this.players[id].name.toLowerCase().includes(playerName.toLowerCase())
            );
            
            if (!playerId) {
                await message.reply(`Player "${playerName}" not found!`);
                return;
            }
            
            const playerData = this.players[playerId];
            await message.reply(`Testing home run details fetching for ${playerData.name}...`);
            
            // Test primary method
            const primaryDetails = await this.getRecentHomeRunDetails(playerId);
            await message.reply(`Primary method results for ${playerData.name}:\nDistance: ${primaryDetails.distance}\nRBI: ${primaryDetails.rbi}\nType: ${primaryDetails.rbiDescription}`);
            
            // Test alternative method
            const alternativeDetails = await this.getHomeRunDetailsFromAlternativeAPI(playerId);
            await message.reply(`Alternative method results for ${playerData.name}:\nDistance: ${alternativeDetails.distance}\nRBI: ${alternativeDetails.rbi}\nType: ${alternativeDetails.rbiDescription}`);
            
        } catch (error) {
            this.log(`Error in test details command: ${error.message}`);
            await message.reply('Error testing home run details!');
        }
    }

    async sendPlayerStats(playerId, message) {
        try {
            const stats = await this.getPlayerStats(playerId);
            const playerData = this.players[playerId];
            
            if (!stats) {
                await message.reply(`Sorry, I couldn't get stats for ${playerData.name} right now!`);
                return;
            }

            const embed = new Discord.EmbedBuilder()
                .setTitle(`${playerData.name} ${this.currentSeason} Stats`)
                .addFields(
                    { name: '⚾ Hitting', value: `**AVG:** ${stats.avg || 'N/A'} | **HR:** ${stats.homeRuns || 0} | **RBI:** ${stats.rbi || 0} | **R:** ${stats.runs || 0}`, inline: false },
                    { name: '📊 Advanced', value: `**OBP:** ${stats.obp || 'N/A'} | **SLG:** ${stats.slg || 'N/A'} | **OPS:** ${stats.ops || 'N/A'}`, inline: false },
                    { name: '🏃 Other', value: `**H:** ${stats.hits || 0} | **AB:** ${stats.atBats || 0} | **SB:** ${stats.stolenBases || 0} | **SO:** ${stats.strikeOuts || 0} | **BB:** ${stats.baseOnBalls || 0}`, inline: false },
                    { name: '🤖 Bot Tracking', value: `**Last Checked:** ${this.players[playerId].lastCheckedHR} HR`, inline: false }
                )
                .setColor('#132448')
                .setTimestamp()
                .setFooter({ text: `Team: ${playerData.team} | #${playerData.number}` });

            // Add player headshot
            const headshots = {
                'Aaron Judge': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/592450/headshot/67/current',
                'Jazz Chisholm Jr.': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/665862/headshot/67/current',
                'Juan Soto': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/665742/headshot/67/current',
                'Shohei Ohtani': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/660271/headshot/67/current',
                'Kyle Schwarber': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/656941/headshot/67/current',
                'Ronald Acuña Jr.': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/660670/headshot/67/current',
                'Pete Alonso': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/624413/headshot/67/current',
                'Bryce Harper': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/547180/headshot/67/current'
            };
            
            if (headshots[playerData.name]) {
                embed.setThumbnail(headshots[playerData.name]);
            }
            
            await message.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Error in sendPlayerStats:', error);
            await message.reply('Sorry, I had trouble getting the stats right now!');
        }
    }

    async sendTrackedPlayers(message) {
        const playerList = Object.values(this.players)
            .map(player => `• ${player.name} (${player.team} #${player.number})`)
            .join('\n');

        const embed = new Discord.EmbedBuilder()
            .setTitle('📊 Tracked Players')
            .setDescription(`Currently monitoring these players for home runs:\n\n${playerList}`)
            .addFields(
                { name: 'Player Commands', value: '!judge, !jazz, !soto, !ohtani, !schwarber, !acuna, !alonso, !harper', inline: false },
                { name: 'General Commands', value: '!hrstats, !testhr, !players', inline: false },
                { name: 'Debug Commands', value: '!debug, !forcecheck, !reset [player], !testdetails [player]', inline: false },
                { name: 'Alert Channels', value: `Sending to ${this.channelIds.length} channel(s)`, inline: false }
            )
            .setColor('#132448')
            .setTimestamp();

        await message.reply({ embeds: [embed] });
    }

    async sendAllHomeRunStats(message) {
        try {
            const hrStats = [];
            
            for (const [playerId, playerData] of Object.entries(this.players)) {
                const homeRuns = await this.getPlayerHomeRuns(playerId);
                hrStats.push({
                    name: playerData.name,
                    team: playerData.team,
                    homeRuns: homeRuns,
                    tracked: playerData.lastCheckedHR
                });
            }
            
            // Sort by home runs (descending)
            hrStats.sort((a, b) => b.homeRuns - a.homeRuns);
            
            const statsText = hrStats
                .map((player, index) => `${index + 1}. ${player.name} (${player.team}): ${player.homeRuns} HR (tracking: ${player.tracked})`)
                .join('\n');

            const embed = new Discord.EmbedBuilder()
                .setTitle(`🏆 ${this.currentSeason} Home Run Leaderboard`)
                .setDescription(statsText)
                .setColor('#FFD700')
                .setTimestamp()
                .setFooter({ text: 'Numbers in parentheses show what the bot last recorded' });

            await message.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Error in sendAllHomeRunStats:', error);
            await message.reply('Sorry, I had trouble getting the home run stats!');
        }
    }

    async sendTestHomeRunAlert(message) {
        try {
            // Pick a random player for the test
            const playerIds = Object.keys(this.players);
            const randomPlayerId = playerIds[Math.floor(Math.random() * playerIds.length)];
            const playerData = this.players[randomPlayerId];
            
            // Create sample home run data
            const sampleDistances = ['415 ft', '438 ft', '462 ft', '395 ft', '441 ft', '478 ft'];
            const sampleRBIs = [1, 2, 3, 4];
            const sampleHRTypes = ['Solo HR', '2-run HR', '3-run HR', 'Grand Slam!'];
            
            const randomDistance = sampleDistances[Math.floor(Math.random() * sampleDistances.length)];
            const randomRBI = sampleRBIs[Math.floor(Math.random() * sampleRBIs.length)];
            const randomHRType = sampleHRTypes[randomRBI - 1];
            
            const testDetails = {
                distance: randomDistance,
                rbi: randomRBI,
                rbiDescription: randomHRType
            };
            
            // Create the embed for test (same as sendHomeRunAlert but only send to current channel)
            const hrType = testDetails.rbiDescription || 'Solo HR';
            const titleText = hrType === 'Grand Slam!' ? 
                `⚾ ${playerData.name.toUpperCase()} GRAND SLAM! ⚾` :
                `⚾ ${playerData.name.toUpperCase()} ${hrType.toUpperCase().replace(' HR', ' HOME RUN')}! ⚾`;
            
            const embed = new Discord.EmbedBuilder()
                .setTitle(titleText)
                .setDescription(`${playerData.name} just hit a home run! (TEST ALERT)`)
                .addFields(
                    { name: 'Player', value: `${playerData.name} (#${playerData.number})`, inline: true },
                    { name: 'Team', value: playerData.team, inline: true },
                    { name: 'Season Total', value: `${Math.floor(Math.random() * 40) + 10} HR`, inline: true },
                    { name: 'Distance', value: testDetails.distance, inline: true }
                )
                .setColor('#132448')
                .setTimestamp();

            // Set player headshot using MLB's official headshot URLs
            const headshots = {
                'Aaron Judge': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/592450/headshot/67/current',
                'Jazz Chisholm Jr.': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/665862/headshot/67/current',
                'Juan Soto': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/665742/headshot/67/current',
                'Shohei Ohtani': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/660271/headshot/67/current',
                'Kyle Schwarber': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/656941/headshot/67/current',
                'Ronald Acuña Jr.': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/660670/headshot/67/current',
                'Pete Alonso': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/624413/headshot/67/current',
                'Bryce Harper': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/547180/headshot/67/current'
            };
            
            if (headshots[playerData.name]) {
                embed.setThumbnail(headshots[playerData.name]);
            }

            // Send only to the current channel where the command was issued
            await message.channel.send({ embeds: [embed] });
            
            await message.reply(`🧪 Test alert sent to this channel for ${playerData.name}!`);
        } catch (error) {
            this.log(`Error sending test message: ${error.message}`);
            await message.reply('Sorry, I had trouble sending the test alert!');
        }
    }
}

// Usage - Parse multiple channel IDs from environment
const botToken = process.env.BOT_TOKEN;
const channelIdString = process.env.CHANNEL_ID;

if (!botToken || !channelIdString) {
    console.error('Missing required environment variables: BOT_TOKEN and/or CHANNEL_ID');
    process.exit(1);
}

// Parse comma-separated channel IDs
const channelIds = channelIdString.split(',').map(id => id.trim()).filter(id => id.length > 0);

if (channelIds.length === 0) {
    console.error('No valid channel IDs found in CHANNEL_ID environment variable');
    process.exit(1);
}

console.log(`Starting bot with ${channelIds.length} channel(s): ${channelIds.join(', ')}`);

const bot = new BaseballBot(botToken, channelIds);

process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully');
    bot.client.destroy();
    process.exit(0);
});

bot.initialize().catch(console.error);