import { Type } from '@sinclair/typebox';
import type { AdminContext, AdminContribution, AdminError, AdminRouteResponse } from '@agents-io/protocol';
import { AdminLarkBotJob, AdminLarkBotRequest, AdminLarkBotStarted, LARK_BOT_ADMIN_ENDPOINTS } from './admin.js';
import { LarkBotJobs } from './provision.js';

/*
 * What the lark-bot module adds to the daemon's console (core-slimming G5): the setting
 * `console.larkBotCommand`, the JSON Schemas of its endpoints, the endpoints themselves
 * (`POST /api/bots/lark`, `GET /api/bots/lark/:job`, admin.ts) and the provisioning jobs behind
 * them (`LarkBotJobs`, provision.ts), built from the daemon's `AdminContext` when its console
 * starts and stopped with it. `larkBotChannelModule.admin` is this.
 */

/** create-lark-bot, pinned: the default of `console.larkBotCommand`. */
export const CREATE_LARK_BOT = ['npx', '-y', 'github:Ghost-LZW/create-lark-bot#v0.2.4'];

/** The jobs of each daemon's console (one context per daemon, see `AdminContext`). */
const jobsOf = new WeakMap<AdminContext, LarkBotJobs>();

const fail = (status: number, code: string, message: string): AdminRouteResponse => ({ status, body: { error: { code, message } } satisfies AdminError });

/** A daemon without a config file has nothing to add a bot to. */
const noConfig = () => fail(404, 'not_found', 'bot provisioning needs a config file');

const [startEndpoint, jobEndpoint] = LARK_BOT_ADMIN_ENDPOINTS;

export const larkBotAdmin: AdminContribution = {
  console: {
    /** create-lark-bot invocation for `POST /api/bots/lark` (argv; default npx of the pinned release). */
    larkBotCommand: Type.Array(Type.String(), { minItems: 1, default: CREATE_LARK_BOT }),
  },
  schemas: { AdminLarkBotRequest, AdminLarkBotStarted, AdminLarkBotJob },
  routes: [
    {
      ...startEndpoint,
      handle(req, ctx) {
        const jobs = jobsOf.get(ctx);
        if (!jobs) return noConfig();
        const r = jobs.start(req.body as AdminLarkBotRequest);
        if (!r.ok) return fail(r.status, r.code, r.message);
        return { status: 202, body: { job: r.job } satisfies AdminLarkBotStarted };
      },
    },
    {
      ...jobEndpoint,
      handle(req, ctx) {
        const jobs = jobsOf.get(ctx);
        if (!jobs) return noConfig();
        const id = req.params.job ?? '';
        const j = jobs.get(id);
        if (!j) return fail(404, 'unknown_job', `no provisioning job ${id}`);
        return { status: 200, body: j };
      },
    },
  ],
  mount(ctx) {
    const config = ctx.config;
    if (!config) return undefined;
    const jobs = new LarkBotJobs({
      command: ctx.console.larkBotCommand as string[],
      dir: ctx.dir,
      config,
      envRefs: (c) => config.envRefs(c),
      ...(ctx.applyChannels ? { applyChannels: () => ctx.applyChannels!() } : {}),
      log: (level, msg) => ctx.log(level, msg),
      env: ctx.env,
    });
    jobsOf.set(ctx, jobs);
    return {
      close: () => {
        jobsOf.delete(ctx);
        jobs.close();
      },
    };
  },
};
