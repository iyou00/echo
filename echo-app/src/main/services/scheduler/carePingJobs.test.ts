import { describe, expect, it } from 'vitest'
import type { CarePingScheduleRecord } from '../../db/carePingSchedule'
import { carePingJobsTestHelpers } from './carePingJobs'

function plan(overrides: Partial<CarePingScheduleRecord> = {}): CarePingScheduleRecord {
  return {
    id: 1,
    date: '2026-08-13',
    windowKey: 'afternoon',
    label: '午后提醒',
    plannedAt: '2026-08-13 14:10',
    status: 'planned',
    deferCount: 0,
    ...overrides,
  }
}

describe('care ping deferred schedule timing', () => {
  it('uses eligibleAfter as the effective execution time', () => {
    const record = plan({ eligibleAfter: '2026-08-13T06:30:00.000Z', deferCount: 1 })

    expect(carePingJobsTestHelpers.shouldCatchUpCarePing(record, new Date('2026-08-13T06:29:00.000Z'))).toBe(false)
    expect(carePingJobsTestHelpers.shouldCatchUpCarePing(record, new Date('2026-08-13T06:31:00.000Z'))).toBe(true)
  })

  it('expires from the deferred time instead of the original plan', () => {
    const record = plan({ eligibleAfter: '2026-08-13T06:30:00.000Z', deferCount: 1 })

    expect(carePingJobsTestHelpers.shouldExpireCarePing(record, new Date('2026-08-13T07:14:00.000Z'))).toBe(false)
    expect(carePingJobsTestHelpers.shouldExpireCarePing(record, new Date('2026-08-13T07:16:00.000Z'))).toBe(true)
  })

  it('caps afternoon deferral at the configured window end', () => {
    expect(carePingJobsTestHelpers.carePingWindowEndAt(plan()).getHours()).toBe(15)
  })
})
