// Domain-state capability handle (ADR-0011): domain vocabulary over the
// runtime's stores. First cut covers configuration entries and registered
// locations — the set the reference surfaces consume today. Live trading
// data joins when the watcher data path is contracted.
import {
  type KfLocation,
  type KfLocator,
  type KfNativeBinding,
  categoryName,
  modeName,
  resolveRuntimeDir,
} from './types';

export type ConfigEntry = {
  location: KfLocation;
  value: string;
};

export type DomainState = {
  runtimeDir: string;
  configs: () => ConfigEntry[];
  setConfig: (location: KfLocation, value: string) => boolean;
  removeConfig: (location: KfLocation) => boolean;
  locations: () => KfLocation[];
};

export type OpenDomainStateOptions = {
  binding: KfNativeBinding;
  locator: KfLocator;
};

export function openDomainState(options: OpenDomainStateOptions): DomainState {
  const { binding } = options;
  const runtimeDir = resolveRuntimeDir(options.locator);
  const store = new binding.ConfigStore(runtimeDir);

  const configs = (): ConfigEntry[] =>
    Object.values(store.getAllConfig()).map((row) => ({
      location: {
        category: categoryName(row.category as number),
        group: String(row.group),
        name: String(row.name),
        mode: modeName(row.mode as number),
      },
      value: String(row.value),
    }));

  const setConfig = (location: KfLocation, value: string): boolean =>
    store.setConfig(
      String(location.category),
      location.group,
      location.name,
      String(location.mode),
      value,
    );

  const removeConfig = (location: KfLocation): boolean =>
    store.removeConfig(
      String(location.category),
      location.group,
      location.name,
      String(location.mode),
    );

  const locations = (): KfLocation[] => {
    const io = new binding.IODevice(
      { category: 'system', group: 'capability', name: 'domain', mode: 'live' },
      runtimeDir,
    );
    return Object.values(io.getAllLocations()).map((row) => ({
      category: String(row.category),
      group: String(row.group),
      name: String(row.name),
      mode: String(row.mode),
    }));
  };

  return { runtimeDir, configs, setConfig, removeConfig, locations };
}
