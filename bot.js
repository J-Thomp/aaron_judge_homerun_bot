require('dotenv').config();
const Discord = require('discord.js');
const axios = require('axios');
const cron = require('node-cron');

class BaseballBot {
    constructor(token, channelId) {
        this.client = new Discord.Client({
            intents: [
                Discord.GatewayIntentBits.Guilds,
                Discord.GatewayIntentBits.GuildMessages,
                Discord.GatewayIntentBits.MessageContent
            ]
        });
        this.token = token;
        this.channelId = channelId;
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
    }

    async initialize() {
        // Initialize home run counts for all players
        for (const playerId of Object.keys(this.players)) {
            this.players[playerId].lastCheckedHR = await this.getPlayerHomeRuns(playerId);
        }
        
        this.client.on('ready', () => {
            console.log(`Bot logged in as ${this.client.user.tag}`);
            this.startMonitoring();
        });

        this.client.on('error', (error) => {
            console.error('Discord client error:', error);
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
            console.error(`Error fetching stats for player ${playerId}:`, error.message);
            return null;
        }
    }

    async getPlayerHomeRuns(playerId) {
        const stats = await this.getPlayerStats(playerId);
        return stats ? parseInt(stats.homeRuns) || 0 : 0;
    }

    async getRecentHomeRunDetails(playerId) {
        try {
            // Get player's recent games
            const gamesResponse = await axios.get(
                `https://statsapi.mlb.com/api/v1/people/${playerId}/gameLog?season=${this.currentSeason}&gameType=R&limit=5`
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
                            if (play.result && play.result.type === 'atBat' && 
                                play.result.event === 'Home Run' && 
                                play.matchup && play.matchup.batter && 
                                play.matchup.batter.id.toString() === playerId) {
                                
                                let distance = "Distance not available";
                                let rbi = play.result.rbi || 0;
                                
                                // Try to get distance from hit data
                                if (play.hitData && play.hitData.totalDistance) {
                                    distance = `${play.hitData.totalDistance} ft`;
                                }
                                
                                // Determine RBI description
                                let rbiDescription = "Solo HR";
                                if (rbi === 2) rbiDescription = "2-run HR";
                                else if (rbi === 3) rbiDescription = "3-run HR";
                                else if (rbi === 4) rbiDescription = "Grand Slam!";
                                
                                return { 
                                    distance: distance, 
                                    rbi: rbi,
                                    rbiDescription: rbiDescription,
                                    gameId: game.gameId
                                };
                            }
                        }
                    } catch (gameError) {
                        console.error(`Error fetching game ${game.gameId} details:`, gameError.message);
                        continue;
                    }
                }
            }
            
            return { distance: "Distance not available", rbi: "RBI not available" };
        } catch (error) {
            console.error('Error fetching home run details:', error.message);
            return { distance: "Distance not available", rbi: "RBI not available" };
        }
    }

    async checkForNewHomeRuns() {
        for (const [playerId, playerData] of Object.entries(this.players)) {
            const currentHomeRuns = await this.getPlayerHomeRuns(playerId);
            
            if (currentHomeRuns > playerData.lastCheckedHR) {
                const newHomeRuns = currentHomeRuns - playerData.lastCheckedHR;
                const homeRunDetails = await this.getRecentHomeRunDetails(playerId);
                await this.sendHomeRunAlert(playerData, currentHomeRuns, newHomeRuns, homeRunDetails);
                this.players[playerId].lastCheckedHR = currentHomeRuns;
            }
        }
    }

    async sendHomeRunAlert(playerData, totalHomeRuns, newCount, details) {
        try {
            const channel = await this.client.channels.fetch(this.channelId);
            
            // Create dynamic title based on HR type
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

            await channel.send({ embeds: [embed] });
            console.log(`Sent home run alert for ${playerData.name}! Total: ${totalHomeRuns}, Distance: ${details.distance}, RBI: ${details.rbi}`);
        } catch (error) {
            console.error('Error sending message:', error.message);
        }
    }

    startMonitoring() {
        // Check every 5 minutes during baseball season (April-October)
        cron.schedule('*/5 * * * *', async () => {
            const now = new Date();
            const month = now.getMonth() + 1;
            
            if (month >= 4 && month <= 10) {
                console.log('Checking for new home runs...');
                await this.checkForNewHomeRuns();
            }
        });
        
        console.log('Started monitoring for home runs from your selected star players!');
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
                    { name: '🏃 Other', value: `**H:** ${stats.hits || 0} | **AB:** ${stats.atBats || 0} | **SB:** ${stats.stolenBases || 0} | **SO:** ${stats.strikeOuts || 0} | **BB:** ${stats.baseOnBalls || 0}`, inline: false }
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
                { name: 'Available Commands', value: '!judge, !jazz, !soto, !ohtani, !schwarber, !acuna, !alonso, !harper, !hrstats, !testhr', inline: false }
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
                    homeRuns: homeRuns
                });
            }
            
            // Sort by home runs (descending)
            hrStats.sort((a, b) => b.homeRuns - a.homeRuns);
            
            const statsText = hrStats
                .map((player, index) => `${index + 1}. ${player.name} (${player.team}): ${player.homeRuns} HR`)
                .join('\n');

            const embed = new Discord.EmbedBuilder()
                .setTitle(`🏆 ${this.currentSeason} Home Run Leaderboard`)
                .setDescription(statsText)
                .setColor('#FFD700')
                .setTimestamp();

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
            
            const channel = message.channel;
            
            // Create dynamic title based on HR type
            const hrType = testDetails.rbiDescription;
            const titleText = hrType === 'Grand Slam!' ? 
                `⚾ ${playerData.name.toUpperCase()} GRAND SLAM! ⚾` :
                `⚾ ${playerData.name.toUpperCase()} ${hrType.toUpperCase().replace(' HR', ' HOME RUN')}! ⚾`;
            
            const embed = new Discord.EmbedBuilder()
                .setTitle(titleText)
                .setDescription(`${playerData.name} just hit a home run! (This is a test alert)`)
                .addFields(
                    { name: 'Player', value: `${playerData.name} (#${playerData.number})`, inline: true },
                    { name: 'Team', value: playerData.team, inline: true },
                    { name: 'Season Total', value: `${Math.floor(Math.random() * 40) + 10} HR`, inline: true },
                    { name: 'Distance', value: testDetails.distance, inline: true }
                )
                .setColor('#132448')
                .setTimestamp()
                .setFooter({ text: '🧪 This is a test alert to show you what home run notifications will look like!' });

            // Set player headshot
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

            await channel.send({ embeds: [embed] });
            console.log(`Sent test home run alert for ${playerData.name}!`);
        } catch (error) {
            console.error('Error sending test message:', error.message);
            await message.reply('Sorry, I had trouble sending the test alert!');
        }
    }
}

// Usage
const botToken = process.env.BOT_TOKEN;
const channelId = process.env.CHANNEL_ID;

if (!botToken || !channelId) {
    console.error('Missing required environment variables: BOT_TOKEN and/or CHANNEL_ID');
    process.exit(1);
}

const bot = new BaseballBot(botToken, channelId);

process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully');
    bot.client.destroy();
    process.exit(0);
});

bot.initialize().catch(console.error);