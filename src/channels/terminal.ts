/**
 * Terminal channel — interact with NanoClaw directly from the command line.
 *
 * Reads messages from stdin (one line = one message) and writes agent replies
 * to stdout. Useful for local development and debugging without needing any
 * external messaging account.
 *
 * Enable by setting TERMINAL_CHANNEL=true in .env or environment.
 * The channel auto-registers as the main group on first start.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

import { ASSISTANT_NAME, TERMINAL_CHANNEL_ENABLED } from '../config.js';
import { logger } from '../logger.js';
import { Channel, NewMessage } from '../types.js';
import { ChannelFactory, ChannelOpts, registerChannel } from './registry.js';

export const TERMINAL_JID = 'terminal://local';
const TERMINAL_FOLDER = 'terminal';
const TERMINAL_NAME = 'Terminal';

// ANSI colours — disabled when stdout is not a TTY (e.g. piped)
const isTTY = Boolean(process.stdout.isTTY);
const colour = (code: string, s: string) =>
  isTTY ? `\x1b[${code}m${s}\x1b[0m` : s;

const dim = (s: string) => colour('2', s);
const bold = (s: string) => colour('1', s);
const cyan = (s: string) => colour('36', s);
const green = (s: string) => colour('32', s);

function printBanner() {
  const line = '─'.repeat(50);
  console.log(dim(line));
  console.log(
    `${bold(cyan('NanoClaw Terminal'))}  ${dim(`(type a message and press Enter)`)}`,
  );
  console.log(dim(`Agent name: ${bold(ASSISTANT_NAME)}  |  /exit to quit`));
  console.log(dim(line));
}

function printPrompt() {
  if (isTTY) process.stdout.write(green('You > '));
}

function printReply(text: string) {
  const prefix = bold(cyan(`${ASSISTANT_NAME} > `));
  const indent = ' '.repeat(`${ASSISTANT_NAME} > `.length);
  const lines = text.split('\n');
  console.log();
  lines.forEach((line, i) => {
    console.log(`${i === 0 ? prefix : indent}${line}`);
  });
  console.log();
  printPrompt();
}

class TerminalChannel implements Channel {
  readonly name = 'terminal';

  private rl: readline.Interface | null = null;
  private connected = false;
  private opts: ChannelOpts;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.connected = true;

    // Auto-register as main group if not already registered
    const groups = this.opts.registeredGroups();
    if (!groups[TERMINAL_JID]) {
      this.opts.onChatMetadata(
        TERMINAL_JID,
        new Date().toISOString(),
        TERMINAL_NAME,
        'terminal',
        false,
      );
      // Defer group registration so index.ts registerGroup can pick it up via IPC
      // Instead we call it directly through the onMessage path with a sentinel.
      // The cleaner way: expose registerGroup through opts — but since that would
      // require interface changes, we self-register by emitting a synthetic IPC file.
      // Simplest approach: just call setRegisteredGroup directly here.
      await this._autoRegister();
    }

    if (process.stdin.isTTY) {
      printBanner();
      printPrompt();
    }

    this.rl = readline.createInterface({
      input: process.stdin,
      output: undefined, // don't let readline echo — we handle prompts manually
      terminal: false,
    });

    this.rl.on('line', (line) => {
      const content = line.trim();
      if (!content) {
        printPrompt();
        return;
      }

      if (/^\/(exit|quit|q)$/i.test(content)) {
        if (isTTY) console.log(dim('Bye!'));
        process.exit(0);
      }

      const msg: NewMessage = {
        id: `terminal-${Date.now()}`,
        chat_jid: TERMINAL_JID,
        sender: 'local-user',
        sender_name: 'You',
        content,
        timestamp: new Date().toISOString(),
        is_from_me: false,
        is_bot_message: false,
      };

      this.opts.onMessage(TERMINAL_JID, msg);
    });

    this.rl.on('close', () => {
      logger.info('Terminal stdin closed');
      // In pipe mode (non-TTY), give the agent time to process queued messages
      // before exiting. In interactive mode, exit immediately.
      if (process.stdin.isTTY) {
        process.exit(0);
      } else {
        // Wait up to 5 minutes for agent to finish, then exit
        setTimeout(() => {
          logger.info('Agent processing timed out, shutting down');
          process.exit(0);
        }, 300000).unref();
      }
    });
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    printReply(text);
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid === TERMINAL_JID;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.rl?.close();
    this.rl = null;
  }

  async setTyping(_jid: string, isTyping: boolean): Promise<void> {
    if (!isTTY) return;
    if (isTyping) {
      process.stdout.write(dim(`${ASSISTANT_NAME} is thinking…\r`));
    } else {
      // Clear the "thinking" line
      process.stdout.write(' '.repeat(40) + '\r');
    }
  }

  private async _autoRegister(): Promise<void> {
    // Dynamically import to avoid circular dependency at module load time
    const { setRegisteredGroup } = await import('../db.js');
    const { GROUPS_DIR } = await import('../config.js');

    setRegisteredGroup(TERMINAL_JID, {
      name: TERMINAL_NAME,
      folder: TERMINAL_FOLDER,
      trigger: ASSISTANT_NAME,
      added_at: new Date().toISOString(),
      isMain: true,
      requiresTrigger: false,
    });

    // Create the group directory (mirrors what index.ts registerGroup does)
    const groupDir = path.join(GROUPS_DIR, TERMINAL_FOLDER);
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

    logger.info(
      { jid: TERMINAL_JID, folder: TERMINAL_FOLDER, groupDir },
      'Terminal channel auto-registered as main group',
    );
  }
}

const factory: ChannelFactory = (opts: ChannelOpts): Channel | null => {
  if (!TERMINAL_CHANNEL_ENABLED) return null;
  return new TerminalChannel(opts);
};

registerChannel('terminal', factory);
