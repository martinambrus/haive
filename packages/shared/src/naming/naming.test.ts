import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTAINER_FAMILY,
  DEFAULT_INSTALL_ID,
  InvalidInstallIdError,
  containerName,
  containerPrefix,
  dashPrefix,
  databaseName,
  databasePrefix,
  imageRepo,
  installId,
  installLabel,
  isContainerOf,
  isVolumeOf,
  networkName,
  ownsLabelValue,
  underscorePrefix,
  volumeName,
  volumePrefix,
} from './index.js';

const ORIGINAL = process.env.HAIVE_INSTALL_ID;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.HAIVE_INSTALL_ID;
  else process.env.HAIVE_INSTALL_ID = ORIGINAL;
});

describe('installId', () => {
  it('defaults to haive when unset or empty', () => {
    delete process.env.HAIVE_INSTALL_ID;
    expect(installId()).toBe(DEFAULT_INSTALL_ID);
    process.env.HAIVE_INSTALL_ID = '';
    expect(installId()).toBe(DEFAULT_INSTALL_ID);
  });

  it('rejects anything Docker or Postgres would reject or fold', () => {
    // Upper case folds in Postgres, so two ids would name one database.
    expect(() => installId({ HAIVE_INSTALL_ID: 'Haive' })).toThrow(InvalidInstallIdError);
    // A leading dash is not a legal Docker object name.
    expect(() => installId({ HAIVE_INSTALL_ID: '-x' })).toThrow(InvalidInstallIdError);
    expect(() => installId({ HAIVE_INSTALL_ID: 'a b' })).toThrow(InvalidInstallIdError);
    expect(() => installId({ HAIVE_INSTALL_ID: 'a/b' })).toThrow(InvalidInstallIdError);
    // No '-': compose builds both `<id>-api` and `<id>_repos` from this one variable and cannot
    // convert between them, so a separator inside the id makes the two halves disagree.
    expect(() => installId({ HAIVE_INSTALL_ID: 'haive-prod' })).toThrow(InvalidInstallIdError);
    expect(() => installId({ HAIVE_INSTALL_ID: 'x'.repeat(33) })).toThrow(InvalidInstallIdError);
  });

  it('accepts the forms an operator would reasonably choose', () => {
    expect(installId({ HAIVE_INSTALL_ID: 'haive2' })).toBe('haive2');
    expect(installId({ HAIVE_INSTALL_ID: 'team_a' })).toBe('team_a');
  });
});

/**
 * The test this module exists for.
 *
 * Every literal below is the name that shipped before the module did. If one of these changes,
 * an existing install stops finding its own containers, volumes and databases — so a failure
 * here is data loss on upgrade, not a style regression.
 */
describe('the default id reproduces the shipped names byte for byte', () => {
  it('containers', () => {
    delete process.env.HAIVE_INSTALL_ID;
    expect(containerName(CONTAINER_FAMILY.cli, 'abc123')).toBe('haive-cli-abc123');
    expect(containerName(CONTAINER_FAMILY.shell, 'a', 'b', 'c')).toBe('haive-shell-a-b-c');
    expect(containerName(CONTAINER_FAMILY.ddev, 'task1')).toBe('haive-ddev-task1');
    expect(containerName(CONTAINER_FAMILY.ide, 'task1')).toBe('haive-ide-task1');
    expect(containerName(CONTAINER_FAMILY.login, 'codex', 'deadbeef')).toBe(
      'haive-login-codex-deadbeef',
    );
    expect(containerName(CONTAINER_FAMILY.egress, 'x')).toBe('haive-egress-x');
    expect(containerName(CONTAINER_FAMILY.squid, 'x')).toBe('haive-squid-x');
  });

  it('container filters', () => {
    delete process.env.HAIVE_INSTALL_ID;
    expect(containerPrefix(CONTAINER_FAMILY.cli)).toBe('haive-cli-');
    expect(containerPrefix(CONTAINER_FAMILY.shell)).toBe('haive-shell-');
    expect(containerPrefix(CONTAINER_FAMILY.ddev)).toBe('haive-ddev-');
  });

  it('volumes', () => {
    delete process.env.HAIVE_INSTALL_ID;
    expect(volumeName('repos')).toBe('haive_repos');
    expect(volumeName('bundles')).toBe('haive_bundles');
    expect(volumeName('wrappers')).toBe('haive_wrappers');
    expect(volumeName('squid_configs')).toBe('haive_squid_configs');
    expect(volumeName('ddev_ca')).toBe('haive_ddev_ca');
    expect(volumeName('npm_cache')).toBe('haive_npm_cache');
    expect(volumeName('ddev_registry_cache')).toBe('haive_ddev_registry_cache');
    expect(volumePrefix('cli_auth')).toBe('haive_cli_auth_');
    expect(volumePrefix('ide_ext')).toBe('haive_ide_ext_');
    expect(volumePrefix('ide_udata')).toBe('haive_ide_udata_');
  });

  it('networks and image repositories', () => {
    delete process.env.HAIVE_INSTALL_ID;
    expect(networkName('network')).toBe('haive-network');
    expect(networkName('sandbox')).toBe('haive-sandbox');
    expect(networkName('models')).toBe('haive-models');
    expect(imageRepo('cli-sandbox')).toBe('haive-cli-sandbox');
    expect(imageRepo('sandbox')).toBe('haive-sandbox');
    expect(imageRepo('ddev-runner')).toBe('haive-ddev-runner');
    expect(imageRepo('env')).toBe('haive-env');
  });

  it('postgres databases', () => {
    delete process.env.HAIVE_INSTALL_ID;
    expect(databaseName('kb_global')).toBe('haive_kb_global');
    expect(databaseName('rag', 'myproject')).toBe('haive_rag_myproject');
    expect(databasePrefix('rag')).toBe('haive_rag_');
  });
});

describe('a second install is disjoint from the first', () => {
  it('separates every family', () => {
    process.env.HAIVE_INSTALL_ID = 'haive2';
    expect(containerName(CONTAINER_FAMILY.cli, 'x')).toBe('haive2-cli-x');
    expect(volumeName('repos')).toBe('haive2_repos');
    expect(networkName('network')).toBe('haive2-network');
    expect(imageRepo('cli-sandbox')).toBe('haive2-cli-sandbox');
    expect(databaseName('kb_global')).toBe('haive2_kb_global');
  });

  // The failure this module exists to prevent: install A's reaper must not match install B's
  // resources. Asserted on the FILTERS, since those are what a reaper actually deletes by.
  it("one install never matches the other install's names", () => {
    delete process.env.HAIVE_INSTALL_ID;
    const first = {
      container: containerName(CONTAINER_FAMILY.cli, 'job'),
      volume: volumeName('cli_auth', 'user', 'codex', 0),
    };
    process.env.HAIVE_INSTALL_ID = 'haive2';
    expect(isContainerOf(CONTAINER_FAMILY.cli, first.container)).toBe(false);
    expect(isVolumeOf('cli_auth', first.volume)).toBe(false);
    // And the reverse: the default install must not match the second's.
    const second = containerName(CONTAINER_FAMILY.cli, 'job');
    delete process.env.HAIVE_INSTALL_ID;
    expect(isContainerOf(CONTAINER_FAMILY.cli, second)).toBe(false);
    expect(isContainerOf(CONTAINER_FAMILY.cli, first.container)).toBe(true);
  });

  // `haive2` starts with `haive`, so a prefix built without the separator would match it. This is
  // the specific way "filter too broad" happens in practice.
  it('a longer id is not a prefix match for the default one', () => {
    process.env.HAIVE_INSTALL_ID = 'haive2';
    const other = containerName(CONTAINER_FAMILY.cli, 'x');
    delete process.env.HAIVE_INSTALL_ID;
    expect(other.startsWith(containerPrefix(CONTAINER_FAMILY.cli))).toBe(false);
    expect(volumeName('repos')).not.toBe('haive2_repos');
  });

  // The two prefixes differ only in the separator they append. That is the property compose
  // depends on: it interpolates ONE variable into `<id>-api` and `<id>_repos` and cannot
  // transform between the conventions, so the code side must not either.
  it('the two prefixes differ only by separator', () => {
    process.env.HAIVE_INSTALL_ID = 'haive_prod';
    expect(dashPrefix()).toBe('haive_prod-');
    expect(underscorePrefix()).toBe('haive_prod_');
    expect(containerName(CONTAINER_FAMILY.cli, 'x')).toBe('haive_prod-cli-x');
    expect(volumeName('repos')).toBe('haive_prod_repos');
    expect(databaseName('kb_global')).toBe('haive_prod_kb_global');
  });
});

describe('install labels', () => {
  afterEach(() => {
    delete process.env.HAIVE_INSTALL_ID;
  });

  it('labels a container with this install id', () => {
    delete process.env.HAIVE_INSTALL_ID;
    expect(installLabel()).toBe('haive.install=haive');
    process.env.HAIVE_INSTALL_ID = 'haive2';
    expect(installLabel()).toBe('haive.install=haive2');
  });

  // The compatibility hinge. Every container on a host that upgrades into this feature carries no
  // install label, and it belongs to the install that created it — the default one.
  it('the default install claims unlabelled resources', () => {
    delete process.env.HAIVE_INSTALL_ID;
    expect(ownsLabelValue(undefined)).toBe(true);
    expect(ownsLabelValue(null)).toBe(true);
    expect(ownsLabelValue('')).toBe(true);
    expect(ownsLabelValue('haive')).toBe(true);
    expect(ownsLabelValue('haive2')).toBe(false);
  });

  // And the asymmetry: a second install must never claim a resource it cannot prove is its own,
  // because claiming means force-removing it.
  it('a non-default install never claims an unlabelled resource', () => {
    process.env.HAIVE_INSTALL_ID = 'haive2';
    expect(ownsLabelValue(undefined)).toBe(false);
    expect(ownsLabelValue(null)).toBe(false);
    expect(ownsLabelValue('')).toBe(false);
    expect(ownsLabelValue('haive')).toBe(false);
    expect(ownsLabelValue('haive2')).toBe(true);
  });
});
