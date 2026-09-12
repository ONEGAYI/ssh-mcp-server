import { it } from 'node:test';
import assert from 'node:assert/strict';
import { CommandLineParser } from '../build/cli/command-line-parser.js';

it('parses explicit SSH arguments without borrowing or changing the host CLI arguments', () => {
  const original = process.argv;
  process.argv = ['node', 'host-cli', '--not-an-ssh-option'];
  try {
    const config = CommandLineParser.parseArgs(['--ssh', JSON.stringify({ name: 'vm', host: '127.0.0.1',
      port: 22, username: 'test', password: 'fixture-only' })]);
    assert.equal(config.configs.vm.host, '127.0.0.1');
    assert.deepEqual(process.argv, ['node', 'host-cli', '--not-an-ssh-option']);
  } finally { process.argv = original; }
});
