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
        
        // Players to monitor - Your requested lineup
        this.players = {
            '592450': { name: 'Aaron Judge', team: 'NYY', number: '99', lastCheckedHR: 0 },
            '665862': { name: 'Jazz Chisholm Jr.', team: 'NYY', number: '13', lastCheckedHR: 0 },
            '665742': { name: 'Juan Soto', team: 'NYM', number: '22', lastCheckedHR: 0 },
            '660271': { name: 'Shohei Ohtani', team: 'LAD', number: '17', lastCheckedHR: 0 },
            '656941': { name: 'Kyle Schwarber', team: 'PHI', number: '12', lastCheckedHR: 0 },
            '608070': { name: 'Ronald Acuña Jr.', team: 'ATL', number: '13', lastCheckedHR: 0 }
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

    async getRecentHomeRunDistance(playerId) {
        try {
            // Get player's recent games to find home run details
            const gamesResponse = await axios.get(
                `https://statsapi.mlb.com/api/v1/people/${playerId}/gameLog?season=${this.currentSeason}&gameType=R&limit=10`
            );
            
            // This is a simplified approach - in reality, getting home run distance
            // requires detailed play-by-play data which is more complex
            // For now, we'll return a placeholder
            return "Distance data not available";
        } catch (error) {
            console.error('Error fetching home run distance:', error.message);
            return "Distance data not available";
        }
    }

    async checkForNewHomeRuns() {
        for (const [playerId, playerData] of Object.entries(this.players)) {
            const currentHomeRuns = await this.getPlayerHomeRuns(playerId);
            
            if (currentHomeRuns > playerData.lastCheckedHR) {
                const newHomeRuns = currentHomeRuns - playerData.lastCheckedHR;
                const distance = await this.getRecentHomeRunDistance(playerId);
                await this.sendHomeRunAlert(playerData, currentHomeRuns, newHomeRuns, distance);
                this.players[playerId].lastCheckedHR = currentHomeRuns;
            }
        }
    }

    async sendHomeRunAlert(playerData, totalHomeRuns, newCount, distance) {
        try {
            const channel = await this.client.channels.fetch(this.channelId);
            
            const embed = new Discord.EmbedBuilder()
                .setTitle(`⚾ ${playerData.name.toUpperCase()} HOME RUN! ⚾`)
                .setDescription(`${playerData.name} just hit ${newCount > 1 ? `${newCount} home runs` : 'a home run'}!`)
                .addFields(
                    { name: 'Player', value: `${playerData.name} (#${playerData.number})`, inline: true },
                    { name: 'Team', value: playerData.team, inline: true },
                    { name: 'Season Total', value: `${totalHomeRuns} HR`, inline: true },
                    { name: 'Distance', value: distance, inline: false }
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
                'Ronald Acuña Jr.': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/608070/headshot/67/current'
            };
            
            if (headshots[playerData.name]) {
                embed.setThumbnail(headshots[playerData.name]);
            }

            await channel.send({ embeds: [embed] });
            console.log(`Sent home run alert for ${playerData.name}! Total: ${totalHomeRuns}`);
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
        
        // Enhanced !judge command with full stats
        if (content === '!judge') {
            await this.sendPlayerStats('592450', message);
        }
        
        // Add commands for other players
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
            await this.sendPlayerStats('608070', message);
        }
        
        // List all tracked players
        if (content === '!players') {
            await this.sendTrackedPlayers(message);
        }
        
        // Show all players' home run totals
        if (content === '!hrstats') {
            await this.sendAllHomeRunStats(message);
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
                    { name: 'Batting Average', value: stats.avg || 'N/A', inline: true },
                    { name: 'Home Runs', value: `${stats.homeRuns || 0}`, inline: true },
                    { name: 'RBIs', value: `${stats.rbi || 0}`, inline: true },
                    { name: 'Runs', value: `${stats.runs || 0}`, inline: true },
                    { name: 'Hits', value: `${stats.hits || 0}`, inline: true },
                    { name: 'At Bats', value: `${stats.atBats || 0}`, inline: true },
                    { name: 'OBP', value: stats.obp || 'N/A', inline: true },
                    { name: 'SLG', value: stats.slg || 'N/A', inline: true },
                    { name: 'OPS', value: stats.ops || 'N/A', inline: true },
                    { name: 'Stolen Bases', value: `${stats.stolenBases || 0}`, inline: true },
                    { name: 'Strikeouts', value: `${stats.strikeOuts || 0}`, inline: true },
                    { name: 'Walks', value: `${stats.baseOnBalls || 0}`, inline: true }
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
                'Ronald Acuña Jr.': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/608070/headshot/67/current'
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
                { name: 'Available Commands', value: '!judge, !jazz, !soto, !ohtani, !schwarber, !acuna, !hrstats', inline: false }
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