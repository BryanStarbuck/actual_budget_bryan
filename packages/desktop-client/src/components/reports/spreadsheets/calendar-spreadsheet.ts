import { send } from '@actual-app/core/platform/client/connection';
import * as monthUtils from '@actual-app/core/shared/months';
import { q } from '@actual-app/core/shared/query';
import type { RuleConditionEntity } from '@actual-app/core/types/models';
import type { SyncedPrefs } from '@actual-app/core/types/prefs';
import { errorFileFor, tryOrAsync } from '@actual-app/error-file';
import * as d from 'date-fns';

import type { useSpreadsheet } from '#hooks/useSpreadsheet';
import { aqlQuery } from '#queries/aqlQuery';

const errors = errorFileFor(
  'desktop-client/src/components/reports/spreadsheets/calendar-spreadsheet.ts',
);

export type CalendarDataType = {
  date: Date;
  incomeValue: number;
  expenseValue: number;
  incomeSize: number;
  expenseSize: number;
};
export function calendarSpreadsheet(
  start: string,
  end: string,
  conditions: RuleConditionEntity[] = [],
  conditionsOp: 'and' | 'or' = 'and',
  firstDayOfWeekIdx?: SyncedPrefs['firstDayOfWeekIdx'],
) {
  return async (
    spreadsheet: ReturnType<typeof useSpreadsheet>,
    setData: (data: {
      calendarData: {
        start: Date;
        end: Date;
        data: CalendarDataType[];
        totalExpense: number;
        totalIncome: number;
      }[];
    }) => void,
  ) => {
    const filters: unknown[] = await tryOrAsync(
      errors,
      'building the calendar transaction filters',
      async () => {
        const { filters: filtersLocal } = await send(
          'make-filters-from-conditions',
          {
            conditions: conditions.filter(cond => !cond.customName),
          },
        );
        return filtersLocal;
      },
      [],
    );
    const conditionsOpKey = conditionsOp === 'or' ? '$or' : '$and';

    let startDay: Date;
    try {
      startDay = d.parse(
        monthUtils.firstDayOfMonth(start),
        'yyyy-MM-dd',
        new Date(),
      );
    } catch (error) {
      errors.caught('parsing the calendar start date', error);
      throw new Error('Invalid start date format');
    }

    let endDay: Date;
    try {
      endDay = d.parse(
        monthUtils.lastDayOfMonth(end),
        'yyyy-MM-dd',
        new Date(),
      );
    } catch (error) {
      errors.caught('parsing the calendar end date', error);
      throw new Error('Invalid end date format');
    }

    const makeRootQuery = () =>
      q('transactions')
        .filter({
          $and: [
            { date: { $gte: d.format(startDay, 'yyyy-MM-dd') } },
            { date: { $lte: d.format(endDay, 'yyyy-MM-dd') } },
          ],
        })
        .filter({
          [conditionsOpKey]: filters,
        })
        .groupBy(['date'])
        .select(['date', { amount: { $sum: '$amount' } }]);

    const expenseData = await tryOrAsync(
      errors,
      'querying the calendar expense totals',
      () =>
        aqlQuery(
          makeRootQuery().filter({
            $and: { amount: { $lt: 0 } },
          }),
        ),
      { data: [], dependencies: [] },
    );

    const incomeData = await tryOrAsync(
      errors,
      'querying the calendar income totals',
      () =>
        aqlQuery(
          makeRootQuery().filter({
            $and: { amount: { $gt: 0 } },
          }),
        ),
      { data: [], dependencies: [] },
    );

    const getOneDatePerMonth = (start: Date, end: Date) => {
      const months = [];
      let currentDate = d.startOfMonth(start);

      while (!d.isSameMonth(currentDate, end)) {
        months.push(currentDate);
        currentDate = d.addMonths(currentDate, 1);
      }
      months.push(end);

      return months;
    };

    setData(
      recalculate(
        incomeData.data,
        expenseData.data,
        getOneDatePerMonth(startDay, endDay),
        start,
        firstDayOfWeekIdx,
      ),
    );
  };
}

function recalculate(
  incomeData: Array<{
    date: string;
    amount: number;
  }>,
  expenseData: Array<{
    date: string;
    amount: number;
  }>,
  months: Date[],
  start: string,
  firstDayOfWeekIdx?: SyncedPrefs['firstDayOfWeekIdx'],
) {
  const incomeDataMap = new Map<string, number>();
  incomeData.forEach(item => {
    incomeDataMap.set(item.date, item.amount);
  });

  const expenseDataMap = new Map<string, number>();
  expenseData.forEach(item => {
    expenseDataMap.set(item.date, item.amount);
  });

  const parseAndCacheDate = (() => {
    const cache = new Map<string, Date>();
    return (dateStr: string) => {
      if (!cache.has(dateStr)) {
        cache.set(dateStr, d.parse(dateStr, 'yyyy-MM-dd', new Date()));
      }
      return cache.get(dateStr)!;
    };
  })();

  const getDaysArray = (month: Date) => {
    const expenseValues = expenseData
      .filter(f => d.isSameMonth(parseAndCacheDate(f.date), month))
      .map(m => Math.abs(m.amount));
    const incomeValues = incomeData
      .filter(f => d.isSameMonth(parseAndCacheDate(f.date), month))
      .map(m => Math.abs(m.amount));

    const totalExpenseValue = expenseValues.length
      ? expenseValues.reduce((acc, val) => acc + val, 0)
      : null;

    const totalIncomeValue = incomeValues.length
      ? incomeValues.reduce((acc, val) => acc + val, 0)
      : null;

    const getBarLength = (value: number) => {
      if (
        value < 0 &&
        typeof totalExpenseValue === 'number' &&
        totalExpenseValue > 0
      ) {
        const result = (Math.abs(value) / totalExpenseValue) * 100;
        return Number.isFinite(result) ? result : 0;
      } else if (
        value > 0 &&
        typeof totalIncomeValue === 'number' &&
        totalIncomeValue > 0
      ) {
        const result = (value / totalIncomeValue) * 100;
        return Number.isFinite(result) ? result : 0;
      } else {
        return 0;
      }
    };

    const firstDay = d.startOfMonth(month);
    const beginDay = d.startOfWeek(firstDay, {
      weekStartsOn:
        firstDayOfWeekIdx !== undefined &&
        !Number.isNaN(parseInt(firstDayOfWeekIdx)) &&
        parseInt(firstDayOfWeekIdx) >= 0 &&
        parseInt(firstDayOfWeekIdx) <= 6
          ? (parseInt(firstDayOfWeekIdx) as 0 | 1 | 2 | 3 | 4 | 5 | 6)
          : 0,
    });
    let totalDays =
      d.differenceInDays(firstDay, beginDay) + d.getDaysInMonth(firstDay);
    if (totalDays % 7 !== 0) {
      totalDays += 7 - (totalDays % 7);
    }
    const daysArray = [];

    for (let i = 0; i < totalDays; i++) {
      const currentDate = d.addDays(beginDay, i);
      if (!d.isSameMonth(currentDate, firstDay)) {
        daysArray.push({
          date: currentDate,
          incomeValue: 0,
          expenseValue: 0,
          incomeSize: 0,
          expenseSize: 0,
        });
      } else {
        const dateKey = d.format(currentDate, 'yyyy-MM-dd');
        const currentIncome = incomeDataMap.get(dateKey) ?? 0;
        const currentExpense = expenseDataMap.get(dateKey) ?? 0;

        daysArray.push({
          date: currentDate,
          incomeSize: getBarLength(currentIncome),
          incomeValue: Math.abs(currentIncome),
          expenseSize: getBarLength(currentExpense),
          expenseValue: Math.abs(currentExpense),
        });
      }
    }

    return {
      data: daysArray as CalendarDataType[],
      totalExpense: totalExpenseValue ?? 0,
      totalIncome: totalIncomeValue ?? 0,
    };
  };

  return {
    calendarData: months.map(m => {
      return {
        ...getDaysArray(m),
        start: d.startOfMonth(m),
        end: d.endOfMonth(m),
      };
    }),
  };
}
