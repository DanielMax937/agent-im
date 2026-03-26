'use client';

import type { FieldHelpSpec } from './field-help-texts';

export function FieldHelp({ spec }: { spec: FieldHelpSpec }) {
  const { detail, def } = spec;
  const titleFallback = def !== undefined ? `${detail} 默认值：${def}` : detail;
  return (
    <span className="ui-field-help-wrap" tabIndex={0} title={titleFallback}>
      <span className="ui-field-help-icon" aria-label="说明">
        ?
      </span>
      <span className="ui-field-help-tooltip" role="tooltip">
        <span className="ui-field-help-detail">{detail}</span>
        {def !== undefined ? <span className="ui-field-help-default">默认值：{def}</span> : null}
      </span>
    </span>
  );
}
