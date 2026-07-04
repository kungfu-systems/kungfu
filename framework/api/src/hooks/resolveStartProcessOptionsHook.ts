import { ResetOptionHook } from './baseHook';

export type StartProcessOptions = {
  name: string;
  autorestart?: boolean;
  [key: string]: unknown;
};

export type ResolveStartOptionsHook = (
  kfLocation: KungfuApi.DerivedKfLocation,
  options: StartProcessOptions,
) => Promise<StartProcessOptions>;

export default new ResetOptionHook<
  ResolveStartOptionsHook,
  StartProcessOptions
>('ResolveStartOptionsHook');
