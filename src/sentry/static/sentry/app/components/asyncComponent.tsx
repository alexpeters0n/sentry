import {isEqual} from 'lodash';
import PropTypes from 'prop-types';
import React from 'react';
import {Location} from 'history';
import * as Sentry from '@sentry/browser';

import {Client} from 'app/api';
import {metric} from 'app/utils/analytics';
import {t} from 'app/locale';
import AsyncComponentSearchInput from 'app/components/asyncComponentSearchInput';
import LoadingError from 'app/components/loadingError';
import LoadingIndicator from 'app/components/loadingIndicator';
import PermissionDenied from 'app/views/permissionDenied';
import RouteError from 'app/views/routeError';
import getRouteStringFromRoutes from 'app/utils/getRouteStringFromRoutes';

type Props = {
  location?: Location;
  router?: any;
  params?: any;
};

export type AsyncComponentState = {
  loading: boolean;
  reloading: boolean;
  error: boolean;
  errors: object;
  remainingRequests?: number;
  [key: string]: any;
};

export default class AsyncComponent<
  P extends Props = Props,
  S extends AsyncComponentState = AsyncComponentState
> extends React.Component<P, S> {
  static propTypes = {
    location: PropTypes.object,
    router: PropTypes.object,
  };

  static contextTypes = {
    router: PropTypes.object,
  };

  static errorHandler(component, fn) {
    return (...args) => {
      try {
        return fn(...args);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(error);
        setTimeout(() => {
          throw error;
        });
        component.setState({error});
        return null;
      }
    };
  }

  // Override this flag to have the component reload it's state when the window
  // becomes visible again. This will set the loading and reloading state, but
  // will not render a loading state during reloading.
  //
  // eslint-disable-next-line react/sort-comp
  reloadOnVisible = false;

  // When enabling reloadOnVisible, this flag may be used to turn on and off
  // the reloading. This is useful if your component only needs to reload when
  // becoming visible during certain states.
  //
  // eslint-disable-next-line react/sort-comp
  shouldReloadOnVisible = false;

  // This affects how the component behaves when `remountComponent` is called
  // By default, the component gets put back into a "loading" state when re-fetching data.
  // If this is true, then when we fetch data, the original ready component remains mounted
  // and it will need to handle any additional "reloading" states
  shouldReload = false;

  // should `renderError` render the `detail` attribute of a 400 error
  shouldRenderBadRequests = false;

  constructor(props, context) {
    super(props, context);

    this.fetchData = AsyncComponent.errorHandler(this, this.fetchData.bind(this));
    this.render = AsyncComponent.errorHandler(this, this.render.bind(this));

    this.state = this.getDefaultState() as Readonly<S>;

    this._measurement = {
      hasMeasured: false,
    };
    if (props.router && props.router.routes) {
      metric.mark(`async-component-${getRouteStringFromRoutes(props.router.routes)}`);
    }
  }

  componentWillMount() {
    this.api = new Client();
    this.fetchData();

    if (this.reloadOnVisible) {
      document.addEventListener('visibilitychange', this.visibilityReloader);
    }
  }

  // Compatiblity shim for child classes that call super on this hook.
  componentWillReceiveProps(_newProps, _newContext) {}

  componentDidUpdate(prevProps, prevContext) {
    const isRouterInContext = !!prevContext.router;
    const isLocationInProps = prevProps.location !== undefined;

    const currentLocation = isLocationInProps
      ? this.props.location
      : isRouterInContext
      ? this.context.router.location
      : null;
    const prevLocation = isLocationInProps
      ? prevProps.location
      : isRouterInContext
      ? prevContext.router.location
      : null;

    if (!(currentLocation && prevLocation)) {
      return;
    }

    // Take a measurement from when this component is initially created until it finishes it's first
    // set of API requests
    if (
      !this._measurement.hasMeasured &&
      this._measurement.finished &&
      this.props.router &&
      this.props.router.routes
    ) {
      const routeString = getRouteStringFromRoutes(this.props.router.routes);
      metric.measure({
        name: 'app.component.async-component',
        start: `async-component-${routeString}`,
        data: {
          route: routeString,
          error: this._measurement.error,
        },
      });
      this._measurement.hasMeasured = true;
    }

    // Re-fetch data when router params change.
    if (
      !isEqual(this.props.params, prevProps.params) ||
      currentLocation.search !== prevLocation.search ||
      currentLocation.state !== prevLocation.state
    ) {
      this.remountComponent();
    }
  }

  componentWillUnmount() {
    this.api.clear();
    document.removeEventListener('visibilitychange', this.visibilityReloader);
  }

  api: any;
  private _measurement: any;

  // XXX: cant call this getInitialState as React whines
  getDefaultState(): AsyncComponentState {
    const endpoints = this.getEndpoints();
    const state = {
      // has all data finished requesting?
      loading: true,
      // is the component reload
      reloading: false,
      // is there an error loading ANY data?
      error: false,
      errors: {},
    };
    endpoints.forEach(([stateKey, _endpoint]) => {
      state[stateKey] = null;
    });
    return state;
  }

  // Check if we should measure render time for this component
  markShouldMeasure = ({
    remainingRequests,
    error,
  }: {remainingRequests?: number; error?: any} = {}) => {
    if (!this._measurement.hasMeasured) {
      this._measurement.finished = remainingRequests === 0;
      this._measurement.error = error || this._measurement.error;
    }
  };

  remountComponent = () => {
    if (this.shouldReload) {
      this.setState(
        {
          reloading: true,
        },
        this.fetchData
      );
    } else {
      this.setState(this.getDefaultState(), this.fetchData);
    }
  };

  visibilityReloader = () =>
    this.shouldReloadOnVisible &&
    !this.state.loading &&
    !document.hidden &&
    this.reloadData();

  reloadData = () => this.fetchData({reloading: true});

  fetchData = (extraState?: object) => {
    const endpoints = this.getEndpoints();

    if (!endpoints.length) {
      this.setState({loading: false, error: false});
      return;
    }

    // Cancel any in flight requests
    this.api.clear();

    this.setState({
      loading: true,
      error: false,
      remainingRequests: endpoints.length,
      ...extraState,
    });

    endpoints.forEach(([stateKey, endpoint, params, options]: any) => {
      options = options || {};
      // If you're using nested async components/views make sure to pass the
      // props through so that the child component has access to props.location
      const locationQuery = (this.props.location && this.props.location.query) || {};
      let query = (params && params.query) || {};
      // If paginate option then pass entire `query` object to API call
      // It should only be expecting `query.cursor` for pagination
      if (options.paginate || locationQuery.cursor) {
        query = {...locationQuery, ...query};
      }

      this.api.request(endpoint, {
        method: 'GET',
        ...params,
        query,
        success: (data, _, jqXHR) => {
          this.handleRequestSuccess({stateKey, data, jqXHR}, true);
        },
        error: error => {
          // Allow endpoints to fail
          // allowError can have side effects to handle the error
          if (options.allowError && options.allowError(error)) {
            error = null;
          }
          this.handleError(error, [stateKey, endpoint, params, options]);
        },
      });
    });
  };

  onRequestSuccess(_resp /*{stateKey, data, jqXHR}*/) {
    // Allow children to implement this
  }

  onRequestError(_resp, _args) {
    // Allow children to implement this
  }

  handleRequestSuccess = ({stateKey, data, jqXHR}, initialRequest?: boolean) => {
    this.setState(prevState => {
      const state = {
        [stateKey]: data,
        // TODO(billy): This currently fails if this request is retried by SudoModal
        [`${stateKey}PageLinks`]: jqXHR && jqXHR.getResponseHeader('Link'),
      };

      if (initialRequest) {
        state.remainingRequests = prevState.remainingRequests! - 1;
        state.loading = prevState.remainingRequests! > 1;
        state.reloading = prevState.reloading && state.loading;
        this.markShouldMeasure({remainingRequests: state.remainingRequests});
      }

      return state;
    });
    this.onRequestSuccess({stateKey, data, jqXHR});
  };

  handleError(error, args) {
    const [stateKey] = args;
    if (error && error.responseText) {
      Sentry.addBreadcrumb({
        message: error.responseText,
        category: 'xhr',
        level: Sentry.Severity.Error,
      });
    }
    this.setState(prevState => {
      const loading = prevState.remainingRequests! > 1;
      const state: AsyncComponentState = {
        [stateKey]: null,
        errors: {
          ...prevState.errors,
          [stateKey]: error,
        },
        error: prevState.error || !!error,
        remainingRequests: prevState.remainingRequests! - 1,
        loading,
        reloading: prevState.reloading && loading,
      };
      this.markShouldMeasure({remainingRequests: state.remainingRequests, error: true});

      return state;
    });
    this.onRequestError(error, args);
  }

  // DEPRECATED: use getEndpoints()
  getEndpointParams() {
    // eslint-disable-next-line no-console
    console.warn('getEndpointParams is deprecated');
    return {};
  }

  // DEPRECATED: use getEndpoints()
  getEndpoint() {
    // eslint-disable-next-line no-console
    console.warn('getEndpoint is deprecated');
    return null;
  }

  /**
   * Return a list of endpoint queries to make.
   *
   * return [
   *   ['stateKeyName', '/endpoint/', {optional: 'query params'}]
   * ]
   */

  getEndpoints(): ([string, string, any] | [string, string])[] {
    const endpoint = this.getEndpoint();
    if (!endpoint) {
      return [];
    }
    return [['data', endpoint, this.getEndpointParams()]];
  }

  renderSearchInput({onSearchSubmit, stateKey, url, updateRoute, ...other}) {
    const [firstEndpoint]: any = this.getEndpoints() || [];
    const stateKeyOrDefault = stateKey || (firstEndpoint && firstEndpoint[0]);
    const urlOrDefault = url || (firstEndpoint && firstEndpoint[1]);
    return (
      <AsyncComponentSearchInput
        updateRoute={updateRoute}
        onSearchSubmit={onSearchSubmit}
        stateKey={stateKeyOrDefault}
        url={urlOrDefault}
        api={this.api}
        onSuccess={(data, jqXHR) => {
          this.handleRequestSuccess({stateKey: stateKeyOrDefault, data, jqXHR});
        }}
        onError={() => {
          this.renderError(new Error('Error with AsyncComponentSearchInput'));
        }}
        {...other}
      />
    );
  }

  renderLoading() {
    return <LoadingIndicator />;
  }

  renderError(error, disableLog = false, disableReport = false) {
    // 401s are captured by SudoModal, but may be passed back to AsyncComponent if they close the modal without identifying
    const unauthorizedErrors = Object.values(this.state.errors).find(
      resp => resp && resp.status === 401
    );

    // Look through endpoint results to see if we had any 403s, means their role can not access resource
    const permissionErrors = Object.values(this.state.errors).find(
      resp => resp && resp.status === 403
    );

    // If all error responses have status code === 0, then show error message but don't
    // log it to sentry
    const shouldLogSentry =
      !!Object.values(this.state.errors).find(resp => resp && resp.status !== 0) ||
      disableLog;

    if (unauthorizedErrors) {
      return (
        <LoadingError message={t('You are not authorized to access this resource.')} />
      );
    }

    if (permissionErrors) {
      return <PermissionDenied />;
    }

    if (this.shouldRenderBadRequests) {
      const badRequests = Object.values(this.state.errors)
        .filter(
          resp =>
            resp && resp.status === 400 && resp.responseJSON && resp.responseJSON.detail
        )
        .map(resp => resp.responseJSON.detail);

      if (badRequests.length) {
        return <LoadingError message={badRequests.join('\n')} />;
      }
    }

    return (
      <RouteError
        error={error}
        component={this}
        disableLogSentry={!shouldLogSentry}
        disableReport={disableReport}
        onRetry={this.remountComponent}
      />
    );
  }

  renderComponent() {
    return this.state.loading && (!this.shouldReload || !this.state.reloading)
      ? this.renderLoading()
      : this.state.error
      ? this.renderError(new Error('Unable to load all required endpoints'))
      : this.renderBody();
  }

  renderBody(): React.ReactElement {
    // Allow children to implement this
    throw new Error('Not implemented');
  }

  render() {
    return this.renderComponent();
  }
}
