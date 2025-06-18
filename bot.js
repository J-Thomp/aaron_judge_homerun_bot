const Discord = require('discord.js');
const axios = require('axios');
const cron = require('node-cron');
require('dotenv').config();

class AaronJudgeBot {
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
        this.lastCheckedHomeRuns = 0;
        this.currentSeason = new Date().getFullYear();
    }

    async initialize() {
        // Get initial home run count
        this.lastCheckedHomeRuns = await this.getAaronJudgeHomeRuns();
        
        this.client.on('ready', () => {
            console.log(`Bot logged in as ${this.client.user.tag}`);
            this.startMonitoring();
        });

        // Add error handling
        this.client.on('error', (error) => {
            console.error('Discord client error:', error);
        });

        // Add message listener here
        this.client.on('messageCreate', async (message) => {
            console.log(`Received message: "${message.content}" from ${message.author.username}`);
            if (message.author.bot) return;
            await this.handleCommand(message);
        });

        await this.client.login(this.token);
    }

    async getAaronJudgeHomeRuns() {
        try {
            // Using MLB Stats API (free, no key required)
            // Aaron Judge's player ID is 592450
            const response = await axios.get(
                `https://statsapi.mlb.com/api/v1/people/592450/stats?stats=season&season=${this.currentSeason}&group=hitting`
            );
            
            const stats = response.data.stats[0];
            if (stats && stats.splits && stats.splits.length > 0) {
                return parseInt(stats.splits[0].stat.homeRuns) || 0;
            }
            return 0;
        } catch (error) {
            console.error('Error fetching home run data:', error.message);
            return this.lastCheckedHomeRuns; // Return last known value on error
        }
    }

    async checkForNewHomeRuns() {
        const currentHomeRuns = await this.getAaronJudgeHomeRuns();
        
        if (currentHomeRuns > this.lastCheckedHomeRuns) {
            const newHomeRuns = currentHomeRuns - this.lastCheckedHomeRuns;
            await this.sendHomeRunAlert(currentHomeRuns, newHomeRuns);
            this.lastCheckedHomeRuns = currentHomeRuns;
        }
    }

    async sendHomeRunAlert(totalHomeRuns, newCount) {
        try {
            const channel = await this.client.channels.fetch(this.channelId);
            
            const embed = new Discord.EmbedBuilder()
                .setTitle('⚾ AARON JUDGE HOME RUN! ⚾')
                .setDescription(`Aaron Judge just hit ${newCount > 1 ? `${newCount} home runs` : 'a home run'}!`)
                .addFields(
                    { name: 'Season Total', value: `${totalHomeRuns} HR`, inline: true },
                    { name: 'Player', value: 'Aaron Judge (#99)', inline: true }
                )
                .setColor('#132448') // Yankees navy blue
                .setThumbnail('https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/592450/headshot/67/current')
                .setTimestamp();

            await channel.send({ embeds: [embed] });
            console.log(`Sent home run alert! Total: ${totalHomeRuns}`);
        } catch (error) {
            console.error('Error sending message:', error.message);
        }
    }

    startMonitoring() {
        // Check every 5 minutes during baseball season (April-October)
        cron.schedule('*/5 * * * *', async () => {
            const now = new Date();
            const month = now.getMonth() + 1; // 1-12
            
            // Only check during baseball season (April through October)
            if (month >= 4 && month <= 10) {
                console.log('Checking for new Aaron Judge home runs...');
                await this.checkForNewHomeRuns();
            }
        });
        
        console.log('Started monitoring for Aaron Judge home runs!');
    }

    // Manual command to check current stats
    async handleCommand(message) {
        console.log(`Checking command: "${message.content}"`);
        if (message.content === '!judge') {
            console.log('Judge command detected! Fetching stats...');
            try {
                const homeRuns = await this.getAaronJudgeHomeRuns();
                const embed = new Discord.EmbedBuilder()
                    .setTitle('Aaron Judge 2025 Stats')
                    .addFields(
                        { name: 'Home Runs', value: `${homeRuns}`, inline: true }
                    )
                    .setColor('#132448')
                    .setTimestamp();
                
                await message.reply({ embeds: [embed] });
                console.log('Stats sent successfully!');
            } catch (error) {
                console.error('Error in handleCommand:', error);
                await message.reply('Sorry, I had trouble getting the stats right now!');
            }
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

const bot = new AaronJudgeBot(botToken, channelId);

// Keep the process alive (required for Render)
process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully');
    bot.client.destroy();
    process.exit(0);
});

// Start the bot
bot.initialize().catch(console.error);