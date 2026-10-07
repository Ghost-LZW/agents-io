#!/usr/bin/env node
import { run } from '@agents-io/daemon/cli';

/*
 * `aio-dev`: the agents-io daemon CLI (`aio`, packages/daemon) under its old
 * name, kept for existing scripts. `aio-dev send <text>` was the local input
 * command; that is `aio input` now (`aio send` delivers for a host), so it is
 * mapped here.
 */
const argv = process.argv.slice(2);
if (argv[0] === 'send') argv[0] = 'input';
run(argv);
