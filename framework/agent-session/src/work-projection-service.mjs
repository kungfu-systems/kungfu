import { clone } from './work-console-model.mjs';

export class WorkProjectionService {
  constructor({ find }) {
    this.find = find;
  }

  recordNative(ref, projection) {
    const { console, attempt } = this.find(ref);
    if (attempt.backend !== 'native-interactive') {
      throw Object.assign(
        new Error(
          'native Work projection requires a native-interactive attempt',
        ),
        { code: 'attempt_backend_mismatch' },
      );
    }
    attempt.workProjection = clone(projection);
    console.updatedAt = projection.observedAt;
  }
}
