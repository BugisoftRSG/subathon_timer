import * as express from "express";
import * as http from "http";
import * as socketio from "socket.io";
import sqlite3 from 'sqlite3'
import * as sqlite from 'sqlite'
import cfg from '../config.json'
import * as tmi from 'tmi.js';
const USE_MOCK = !!process.env.USE_FDGT_MOCK;

(async () => {
  // open the database
  const db = await sqlite.open({
    filename: './data.db',
    driver: sqlite3.Database
  });
  await db.open();
  await db.run('CREATE TABLE IF NOT EXISTS subs (timestamp INTEGER, ending_at INTEGER, seconds_per_sub INTEGER, plan TEXT, user_name TEXT);');
  await db.run('CREATE TABLE IF NOT EXISTS sub_bombs (timestamp INTEGER, amount_subs INTEGER, plan TEXT, user_name TEXT);');
  await db.run('CREATE TABLE IF NOT EXISTS cheers (timestamp INTEGER, ending_at INTEGER, amount_bits INTEGER, user_name TEXT);');
  await db.run('CREATE TABLE IF NOT EXISTS graph (timestamp INTEGER, ending_at INTEGER);');
  await db.run('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value INTEGER);');


  const twitch = !USE_MOCK ? tmi.Client({
    channels: [cfg.channel],
    identity: cfg.twitch_token ? {
      username: cfg.channel,
      password: cfg.twitch_token
    } : undefined
  }) : tmi.Client({
    options: {debug: true},
    channels: [cfg.channel],
    identity: {
      username: "test",
      password: "oauth:test"
    },
    connection: {
      secure: true,
      server: 'irc.fdgt.dev'
    }
  });

  await twitch.connect().catch(console.error);

  const app = express.default();
  app.use(express.static('public'));

  const server = http.createServer(app);
  const io = new socketio.Server(server);

  let isStarted = false;
  let startedAt = 0;

  const resStart = await db.get("SELECT * FROM settings WHERE key='started_at';");
  if(resStart) {
    isStarted = true;
    startedAt = resStart.value;
    console.log(`Found started_at in data.db: ${new Date(startedAt).toISOString()}`);
  }

  let baseTime = cfg.time.base_value;
  const resTime = await db.get("SELECT * FROM settings WHERE key='base_time';");
  if(resTime) {
    baseTime = resTime.value;
    console.log(`Found base_time in data.db: ${baseTime}`);
  }

  let endingAt = 0;
  const resEndingAt = await db.get("SELECT timestamp,ending_at FROM subs UNION ALL SELECT timestamp,ending_at FROM graph ORDER BY timestamp DESC;")
  if(resEndingAt) {
    endingAt = resEndingAt.ending_at;
    console.log(`Found last timer value in data.db: Ending at ${new Date(endingAt).toISOString()}`);
  }

  const appState = new AppState(twitch, db, io, isStarted, startedAt, endingAt, baseTime);

  registerSocketEvents(appState);
  registerTwitchEvents(appState);

  server.listen(cfg.port, () => {
    console.log(`Open the timer at http://localhost:${cfg.port}/timer.html`);
    if(USE_MOCK) {
      setTimeout(async () => {
        await twitch.say(cfg.channel, 'bits');
        console.log("bits emulated");
      }, 5000);
    }
  });
})();

function registerTwitchEvents(state: AppState) {
  state.twitch.on('message', async (channel: string, userstate: tmi.ChatUserstate, message: string ,self: boolean) => {
    if(self) return;
    if(message.startsWith('?') && cfg.admins.includes(userstate.username||"")) {

      {
        // ?start
        const match = message.match(/^\?start ((\d+:)?\d{2}:\d{2})/);
        if(match) {
          if(!state.isStarted) {
            const timeStr = match[1].split(":");
            if(timeStr.length === 3) {
              const hours = parseInt(timeStr[0], 10);
              const minutes = parseInt(timeStr[1], 10);
              const seconds = parseInt(timeStr[2], 10);
              await state.start((((hours * 60) + minutes) * 60) + seconds);
            } else {
              const minutes = parseInt(timeStr[0], 10);
              const seconds = parseInt(timeStr[1], 10);
              await state.start((minutes * 60) + seconds);
            }
          }
        }
      }

      {
        // ?setbasetime
        const match = message.match(/^\?setbasetime (\d+)/);
        if(match) {
          await state.updateBaseTime(parseInt(match[1], 10));
        }
      }

      {
        // ?forcetimer
        const match = message.match(/^\?forcetimer ((\d+:)?\d{2}:\d{2})/);
        if(match) {
          if(state.isStarted) {
            const timeStr = match[1].split(":");
            if(timeStr.length === 3) {
              const hours = parseInt(timeStr[0], 10);
              const minutes = parseInt(timeStr[1], 10);
              const seconds = parseInt(timeStr[2], 10);
              await state.forceTime((((hours * 60) + minutes) * 60) + seconds);
            } else {
              const minutes = parseInt(timeStr[0], 10);
              const seconds = parseInt(timeStr[1], 10);
              await state.forceTime((minutes * 60) + seconds);
            }
          }
        }
      }

    }
  });

  state.twitch.on('subgift', async (channel: string, username: string, streakMonths: number, recipient: string,
                        methods: tmi.SubMethods, userstate: tmi.SubGiftUserstate) => {
    if(state.endingAt < Date.now()) return;
    const multiplier = multiplierFromPlan(methods.plan);
    const secondsToAdd = Math.round(state.baseTime * multiplier * 1000) / 1000;
    state.addTime(secondsToAdd);
    await state.db.run('INSERT INTO subs VALUES(?, ?, ?, ?, ?);', [Date.now(), state.endingAt, methods.plan||"undefined", username]);
  });

  state.twitch.on('submysterygift', (channel: string, username: string, numbOfSubs: number,
                               methods: tmi.SubMethods, userstate: tmi.SubMysteryGiftUserstate) => {
    console.log('submysterygift');
  });

  state.twitch.on('subscription', async (channel: string, username: string, methods: tmi.SubMethods,
                             message: string, userstate: tmi.SubUserstate) => {
    if(state.endingAt < Date.now()) return;
    const multiplier = multiplierFromPlan(methods.plan);
    const secondsToAdd = Math.round(state.baseTime * multiplier * 1000) / 1000;
    state.addTime(secondsToAdd);
    await state.db.run('INSERT INTO subs VALUES(?, ?, ?, ?, ?);', [Date.now(), state.endingAt, methods.plan||"undefined", username]);
  });

  state.twitch.on('resub', async (channel: string, username: string, months: number, message: string,
                      userstate: tmi.SubUserstate, methods: tmi.SubMethods) => {
    if(state.endingAt < Date.now()) return;
    const multiplier = multiplierFromPlan(methods.plan);
    const secondsToAdd = Math.round(state.baseTime * multiplier * 1000) / 1000;
    state.addTime(secondsToAdd);
    await state.db.run('INSERT INTO subs VALUES(?, ?, ?, ?, ?);', [Date.now(), state.endingAt, methods.plan||"undefined", username]);
  });

  state.twitch.on('cheer', async (channel: string, userstate: tmi.ChatUserstate, message: string) => {
    const bits = parseInt(userstate.bits || "0", 10);
    if(state.endingAt < Date.now()) return;
    const multiplier = cfg.time.multipliers.bits;
    const secondsToAdd = Math.round((bits / 100) * multiplier * state.baseTime * 1000) / 1000;
    state.addTime(secondsToAdd);
    await state.db.run('INSERT INTO cheers VALUES(?, ?, ?, ?);', [Date.now(), state.endingAt, bits, userstate.username||"ananonymouscheerer"]);
  });
}

function registerSocketEvents(state: AppState) {
  state.io.on('connection', (socket) => {
    socket.emit('update_incentives', {
      'tier_1': Math.round(state.baseTime * cfg.time.multipliers.tier_1),
      'tier_2': Math.round(state.baseTime * cfg.time.multipliers.tier_2),
      'tier_3': Math.round(state.baseTime * cfg.time.multipliers.tier_3),
      'bits': Math.round(state.baseTime * cfg.time.multipliers.bits),
      'donation': Math.round(state.baseTime * cfg.time.multipliers.donation)
    });
    socket.emit('update_timer', {'ending_at': state.endingAt, 'forced': true});
    socket.emit('update_uptime', {'started_at': state.startedAt});
  });
}

class AppState {
  twitch: tmi.Client;
  db: sqlite.Database;
  io: socketio.Server;

  isStarted: boolean;
  startedAt: number;

  endingAt: number;
  baseTime: number;

  constructor(twitch: tmi.Client, db: sqlite.Database, io: socketio.Server,
              isStarted: boolean, startedAt: number, endingAt: number, baseTime: number) {
    this.twitch = twitch;
    this.db = db;
    this.io = io;
    this.isStarted = isStarted;
    this.startedAt = startedAt;
    this.endingAt = endingAt;
    this.baseTime = baseTime;

    setInterval(async () => {
      if(!this.isStarted || this.endingAt < Date.now()) return;
      await db.run(`INSERT INTO graph VALUES(?, ?);`, [Date.now(), this.endingAt]);
      // Keep only the latest 120 records
      await db.run('DELETE FROM graph WHERE timestamp IN (SELECT timestamp FROM graph ORDER BY timestamp DESC LIMIT -1 OFFSET 120);');
    }, 1000*60);
  }

  async updateBaseTime(newBaseTime: number) {
    this.baseTime = newBaseTime;
    this.io.emit('update_incentives', {
      'tier_1': Math.round(this.baseTime * cfg.time.multipliers.tier_1),
      'tier_2': Math.round(this.baseTime * cfg.time.multipliers.tier_2),
      'tier_3': Math.round(this.baseTime * cfg.time.multipliers.tier_3),
      'bits': Math.round(this.baseTime * cfg.time.multipliers.bits),
      'donation': Math.round(this.baseTime * cfg.time.multipliers.donation)
    });
    await this.db.run('INSERT OR REPLACE INTO settings VALUES (?, ?);', ['base_time', newBaseTime]);
  }

  async start(seconds: number) {
    this.isStarted = true;
    this.startedAt = Date.now();
    this.forceTime(seconds);
    this.io.emit('update_uptime', {'started_at': this.startedAt});
    await this.db.run('INSERT OR REPLACE INTO settings VALUES (?, ?);', ['started_at', this.startedAt]);
  }

  forceTime(seconds: number) {
    this.endingAt = Date.now() + (seconds * 1000);
    this.io.emit('update_timer', {'ending_at': this.endingAt, 'forced': true});
  }

  addTime(seconds: number) {
    this.endingAt = this.endingAt + (seconds * 1000);
    this.io.emit('update_timer', {'ending_at': this.endingAt});
    console.log(`Added ${seconds} seconds.`);
  }

}

function multiplierFromPlan(plan: tmi.SubMethod|undefined) {
  if(!plan) return cfg.time.multipliers.tier_1;
  switch (plan) {
    case "Prime":
      return cfg.time.multipliers.tier_1;
    case "1000":
      return cfg.time.multipliers.tier_1;
    case "2000":
      return cfg.time.multipliers.tier_2;
    case "3000":
      return cfg.time.multipliers.tier_3;
  }
}