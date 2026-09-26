// 기존 화면의 스타일을 빌드 때만 읽는다. 서버 모듈은 브라우저 번들에 넣지 않는다.
import {dashboardWorkspaceStyle} from '../src/dashboard-workspace-style.mjs';
import {dashboardStatusStyle} from '../src/dashboard-status.mjs';
import {watchOverviewStyle} from '../src/watch-overview-wall.mjs';
import {decisionStyle} from '../src/decision-wall.mjs';
import {uiFoundationStyle} from '../src/ui-foundation.mjs';
import {themeToggleStyle,themeStyleSheet} from '../src/theme.mjs';

export const dashboardStyles = css => themeStyleSheet([
 dashboardWorkspaceStyle, dashboardStatusStyle, watchOverviewStyle,
 decisionStyle, themeToggleStyle, uiFoundationStyle, css,
].join('\n'));
