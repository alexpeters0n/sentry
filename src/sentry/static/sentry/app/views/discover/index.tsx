import React from 'react';
import {browserHistory} from 'react-router';
import DocumentTitle from 'react-document-title';

import {getUserTimezone, getUtcToLocalDateObject} from 'app/utils/dates';
import {t} from 'app/locale';
import {updateProjects, updateDateTime} from 'app/actionCreators/globalSelection';
import withGlobalSelection from 'app/utils/withGlobalSelection';
import withOrganization from 'app/utils/withOrganization';
import Feature from 'app/components/acl/feature';
import Alert from 'app/components/alert';

import Discover from './discover';
import createQueryBuilder from './queryBuilder';

import {
  getQueryFromQueryString,
  fetchSavedQuery,
  parseSavedQuery,
  getView,
} from './utils';

import {DiscoverWrapper} from './styles';
import {GlobalSelection, Organization, SavedQuery} from './types';

const AlertAsAny: any = Alert;

type Props = {
  organization: Organization;
  selection: GlobalSelection;
  params: any;
  location: any;
};

type State = {
  isLoading: boolean;
  savedQuery: SavedQuery | null;
  view: string;
};

class DiscoverContainer extends React.Component<Props, State> {
  private queryBuilder: any;

  constructor(props: Props) {
    super(props);

    this.state = {
      isLoading: true,
      savedQuery: null,
      view: getView(props.params, props.location.query.view),
    };

    const {search} = props.location;
    const {organization} = props;

    const query = getQueryFromQueryString(search);

    if (query.hasOwnProperty('projects')) {
      // Update global store with projects from querystring
      updateProjects(query.projects);
    } else {
      // Update query with global projects
      query.projects = props.selection.projects;
    }

    if (['range', 'start', 'end'].some(key => query.hasOwnProperty(key))) {
      // Update global store with datetime from querystring
      const timezone = getUserTimezone();

      // start/end will always be in UTC, however we need to coerce into
      // system time for date picker to be able to synced.
      updateDateTime({
        start: (query.start && getUtcToLocalDateObject(query.start)) || null,
        end: (query.end && getUtcToLocalDateObject(query.end)) || null,
        period: query.range || null,
        utc: query.utc || timezone === 'UTC',
      });
    } else {
      // Update query with global datetime values
      query.start = props.selection.datetime.start;
      query.end = props.selection.datetime.end;
      query.range = props.selection.datetime.period;
      query.utc = props.selection.datetime.utc;
    }

    this.queryBuilder = createQueryBuilder(query, organization);
  }

  componentDidMount() {
    document.body.classList.add('body-discover');

    const {savedQueryId} = this.props.params;

    if (savedQueryId) {
      this.loadTags()
        .then(() => this.fetchSavedQuery(savedQueryId))
        .then(this.setLoadedState);
    } else {
      this.loadTags().then(this.setLoadedState);
    }
  }

  componentWillReceiveProps(nextProps: Props) {
    if (!nextProps.params.savedQueryId) {
      this.setState({savedQuery: null});
      // Reset querybuilder if we're switching from a saved query
      if (this.props.params.savedQueryId) {
        const {datetime, projects} = nextProps.selection;
        const {start, end, period: range} = datetime;
        this.queryBuilder.reset({projects, range, start, end});
      }
      return;
    }

    if (nextProps.params.savedQueryId !== this.props.params.savedQueryId) {
      this.fetchSavedQuery(nextProps.params.savedQueryId);
    }

    if (nextProps.location.query.view !== this.props.location.query.view) {
      this.setState({view: getView(nextProps.params, nextProps.location.query.view)});
    }
  }

  componentWillUnmount() {
    this.queryBuilder.cancelRequests();
    document.body.classList.remove('body-discover');
  }

  loadTags = () => {
    return this.queryBuilder.load();
  };

  setLoadedState = () => {
    this.setState({isLoading: false});
  };

  fetchSavedQuery = (savedQueryId: string) => {
    const {organization} = this.props;

    return fetchSavedQuery(organization, savedQueryId)
      .then((resp: any) => {
        if (this.queryBuilder) {
          this.queryBuilder.reset(parseSavedQuery(resp));
        } else {
          this.queryBuilder = createQueryBuilder(parseSavedQuery(resp), organization);
        }

        this.setState({isLoading: false, savedQuery: resp, view: 'saved'});
      })
      .catch(() => {
        browserHistory.push({
          pathname: `/organizations/${organization.slug}/discover/`,
          query: {view: 'saved'},
        });
        window.location.reload();
      });
  };

  updateSavedQuery = (savedQuery: SavedQuery) => {
    this.setState({savedQuery});
  };

  toggleEditMode = () => {
    const {organization} = this.props;
    const {savedQuery} = this.state;
    const isEditingSavedQuery = this.props.location.query.editing === 'true';

    const newQuery = {...this.props.location.query};
    if (!isEditingSavedQuery) {
      newQuery.editing = 'true';
    } else {
      delete newQuery.editing;
    }

    browserHistory.push({
      pathname: `/organizations/${organization.slug}/discover/saved/${savedQuery!.id}/`,
      query: newQuery,
    });
  };

  renderNoAccess() {
    return (
      <AlertAsAny type="warning">{t("You don't have access to this feature")}</AlertAsAny>
    );
  }

  render() {
    const {isLoading, savedQuery, view} = this.state;

    const {location, organization, params, selection} = this.props;

    return (
      <DocumentTitle title={`Discover - ${organization.slug} - Sentry`}>
        <Feature
          features={['organizations:discover']}
          hookName="discover-page"
          organization={organization}
          renderDisabled={this.renderNoAccess}
        >
          <DiscoverWrapper>
            <Discover
              utc={selection.datetime.utc}
              isLoading={isLoading}
              organization={organization}
              queryBuilder={this.queryBuilder}
              location={location}
              params={params}
              savedQuery={savedQuery}
              isEditingSavedQuery={this.props.location.query.editing === 'true'}
              updateSavedQueryData={this.updateSavedQuery}
              view={view}
              toggleEditMode={this.toggleEditMode}
            />
          </DiscoverWrapper>
        </Feature>
      </DocumentTitle>
    );
  }
}

export default withGlobalSelection(withOrganization(DiscoverContainer));
export {DiscoverContainer};
