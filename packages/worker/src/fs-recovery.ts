import { setParkRecoveryOnWrites } from '@haive/shared/fs-safe';

// Imported only by the worker entry point. The api must never sweep repository parks.
setParkRecoveryOnWrites(true);
