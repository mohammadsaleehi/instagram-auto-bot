/**
 * Persistence facade for schedules. Scheduling logic lives in Scheduler.
 */
export class ScheduleStore {
  /**
   * @param {import('../storage/repositories/schedule-repository.js').ScheduleRepository} schedules
   */
  constructor(schedules) {
    this.schedules = schedules;
  }

  /**
   * @param {Parameters<import('../storage/repositories/schedule-repository.js').ScheduleRepository['upsert']>[0]} input
   */
  save(input) {
    return this.schedules.upsert(input);
  }

  /**
   * @param {string} id
   */
  get(id) {
    return this.schedules.getById(id);
  }

  /**
   * @returns {ReturnType<import('../storage/repositories/schedule-repository.js').ScheduleRepository['listAll']>}
   */
  list() {
    return this.schedules.listAll();
  }

  /**
   * @param {string} nowIso
   */
  listDue(nowIso) {
    return this.schedules.listEnabledDue(nowIso);
  }

  /**
   * @param {string} id
   * @param {Parameters<import('../storage/repositories/schedule-repository.js').ScheduleRepository['update']>[1]} patch
   */
  update(id, patch) {
    return this.schedules.update(id, patch);
  }
}
