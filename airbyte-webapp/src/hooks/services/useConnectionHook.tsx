import { useCallback } from "react";
import { useMutation, useQueryClient } from "react-query";

import { getFrequencyType } from "config/utils";
import { Action, Namespace } from "core/analytics";
import { SyncSchema } from "core/domain/catalog";
import { WebBackendConnectionService } from "core/domain/connection";
import { ConnectionService } from "core/domain/connection/ConnectionService";
import { useInitService } from "services/useInitService";

import { useConfig } from "../../config";
import {
  ConnectionScheduleData,
  ConnectionScheduleType,
  ConnectionStatus,
  DestinationRead,
  NamespaceDefinitionType,
  OperationCreate,
  SourceDefinitionRead,
  SourceRead,
  WebBackendConnectionRead,
  WebBackendConnectionUpdate,
} from "../../core/request/AirbyteClient";
import { useSuspenseQuery } from "../../services/connector/useSuspenseQuery";
import { SCOPE_WORKSPACE } from "../../services/Scope";
import { useDefaultRequestMiddlewares } from "../../services/useDefaultRequestMiddlewares";
import { useAnalyticsService } from "./Analytics";
import { useCurrentWorkspace } from "./useWorkspace";

export const connectionsKeys = {
  all: [SCOPE_WORKSPACE, "connections"] as const,
  lists: () => [...connectionsKeys.all, "list"] as const,
  list: (filters: string) => [...connectionsKeys.lists(), { filters }] as const,
  detail: (connectionId: string) => [...connectionsKeys.all, "details", connectionId] as const,
  getState: (connectionId: string) => [...connectionsKeys.all, "getState", connectionId] as const,
};

export interface ValuesProps {
  name?: string;
  scheduleData: ConnectionScheduleData | undefined;
  scheduleType: ConnectionScheduleType;
  prefix: string;
  syncCatalog: SyncSchema;
  namespaceDefinition: NamespaceDefinitionType;
  namespaceFormat?: string;
  operations?: OperationCreate[];
}

interface CreateConnectionProps {
  values: ValuesProps;
  source: SourceRead;
  destination: DestinationRead;
  sourceDefinition?: Pick<SourceDefinitionRead, "sourceDefinitionId">;
  destinationDefinition?: { name: string; destinationDefinitionId: string };
  sourceCatalogId: string | undefined;
}

export interface ListConnection {
  connections: WebBackendConnectionRead[];
}

function useWebConnectionService() {
  const config = useConfig();
  const middlewares = useDefaultRequestMiddlewares();
  return useInitService(
    () => new WebBackendConnectionService(config.apiUrl, middlewares),
    [config.apiUrl, middlewares]
  );
}

export function useConnectionService() {
  const config = useConfig();
  const middlewares = useDefaultRequestMiddlewares();
  return useInitService(() => new ConnectionService(config.apiUrl, middlewares), [config.apiUrl, middlewares]);
}

export const useConnectionLoad = (
  connectionId: string
): {
  connection: WebBackendConnectionRead;
  refreshConnectionCatalog: () => Promise<WebBackendConnectionRead>;
} => {
  const connection = useGetConnection(connectionId);
  const connectionService = useWebConnectionService();

  const refreshConnectionCatalog = async () => await connectionService.getConnection(connectionId, true);

  return {
    connection,
    refreshConnectionCatalog,
  };
};

export const useSyncConnection = () => {
  const service = useConnectionService();
  const analyticsService = useAnalyticsService();

  return useMutation((connection: WebBackendConnectionRead) => {
    analyticsService.track(Namespace.CONNECTION, Action.SYNC, {
      actionDescription: "Manual triggered sync",
      connector_source: connection.source?.sourceName,
      connector_source_definition_id: connection.source?.sourceDefinitionId,
      connector_destination: connection.destination?.destinationName,
      connector_destination_definition_id: connection.destination?.destinationDefinitionId,
      frequency: getFrequencyType(connection.scheduleData?.basicSchedule),
    });

    return service.sync(connection.connectionId);
  });
};

export const useResetConnection = () => {
  const service = useConnectionService();

  return useMutation((connectionId: string) => service.reset(connectionId));
};

const useGetConnection = (connectionId: string, options?: { refetchInterval: number }): WebBackendConnectionRead => {
  const service = useWebConnectionService();

  return useSuspenseQuery(connectionsKeys.detail(connectionId), () => service.getConnection(connectionId), options);
};

const useCreateConnection = () => {
  const service = useWebConnectionService();
  const queryClient = useQueryClient();
  const analyticsService = useAnalyticsService();

  return useMutation(
    async ({
      values,
      source,
      destination,
      sourceDefinition,
      destinationDefinition,
      sourceCatalogId,
    }: CreateConnectionProps) => {
      const response = await service.create({
        sourceId: source.sourceId,
        destinationId: destination.destinationId,
        ...values,
        status: "active",
        sourceCatalogId,
      });

      const enabledStreams = values.syncCatalog.streams.filter((stream) => stream.config?.selected).length;

      analyticsService.track(Namespace.CONNECTION, Action.CREATE, {
        actionDescription: "New connection created",
        frequency: getFrequencyType(values.scheduleData?.basicSchedule),
        connector_source_definition: source?.sourceName,
        connector_source_definition_id: sourceDefinition?.sourceDefinitionId,
        connector_destination_definition: destination?.destinationName,
        connector_destination_definition_id: destinationDefinition?.destinationDefinitionId,
        available_streams: values.syncCatalog.streams.length,
        enabled_streams: enabledStreams,
      });

      return response;
    },
    {
      onSuccess: (data) => {
        queryClient.setQueryData(connectionsKeys.lists(), (lst: ListConnection | undefined) => ({
          connections: [data, ...(lst?.connections ?? [])],
        }));
      },
    }
  );
};

const useDeleteConnection = () => {
  const service = useConnectionService();
  const queryClient = useQueryClient();
  const analyticsService = useAnalyticsService();

  return useMutation((connection: WebBackendConnectionRead) => service.delete(connection.connectionId), {
    onSuccess: (_data, connection) => {
      analyticsService.track(Namespace.CONNECTION, Action.DELETE, {
        actionDescription: "Connection deleted",
        connector_source: connection.source?.sourceName,
        connector_source_definition_id: connection.source?.sourceDefinitionId,
        connector_destination: connection.destination?.destinationName,
        connector_destination_definition_id: connection.destination?.destinationDefinitionId,
      });

      queryClient.removeQueries(connectionsKeys.detail(connection.connectionId));
      queryClient.setQueryData(
        connectionsKeys.lists(),
        (lst: ListConnection | undefined) =>
          ({
            connections: lst?.connections.filter((conn) => conn.connectionId !== connection.connectionId) ?? [],
          } as ListConnection)
      );
    },
  });
};

const useUpdateConnection = () => {
  const service = useWebConnectionService();
  const queryClient = useQueryClient();

  return useMutation((connectionUpdate: WebBackendConnectionUpdate) => service.update(connectionUpdate), {
    onSuccess: (updatedConnection) => {
      queryClient.setQueryData(connectionsKeys.detail(updatedConnection.connectionId), updatedConnection);
      // Update the connection inside the connections list response
      queryClient.setQueryData<ListConnection>(connectionsKeys.lists(), (ls) => ({
        ...ls,
        connections:
          ls?.connections.map((conn) => {
            if (conn.connectionId === updatedConnection.connectionId) {
              return updatedConnection;
            }
            return conn;
          }) ?? [],
      }));
    },
  });
};

/**
 * Sets the enable/disable status of a connection. It will use the useConnectionUpdate method
 * to make sure all caches are properly updated, but in addition will trigger the Reenable/Disable
 * analytic event.
 */
export const useEnableConnection = () => {
  const analyticsService = useAnalyticsService();
  const { mutateAsync: updateConnection } = useUpdateConnection();

  return useMutation(
    ({ connectionId, enable }: { connectionId: WebBackendConnectionUpdate["connectionId"]; enable: boolean }) =>
      updateConnection({ connectionId, status: enable ? ConnectionStatus.active : ConnectionStatus.inactive }),
    {
      onSuccess: (connection) => {
        const action = connection.status === ConnectionStatus.active ? Action.REENABLE : Action.DISABLE;

        analyticsService.track(Namespace.CONNECTION, action, {
          frequency: getFrequencyType(connection.scheduleData?.basicSchedule),
          connector_source: connection.source?.sourceName,
          connector_source_definition_id: connection.source?.sourceDefinitionId,
          connector_destination: connection.destination?.destinationName,
          connector_destination_definition_id: connection.destination?.destinationDefinitionId,
        });
      },
    }
  );
};

export const useRemoveConnectionsFromList = (): ((connectionIds: string[]) => void) => {
  const queryClient = useQueryClient();

  return useCallback(
    (connectionIds: string[]) => {
      queryClient.setQueryData(connectionsKeys.lists(), (ls: ListConnection | undefined) => ({
        ...ls,
        connections: ls?.connections.filter((c) => !connectionIds.includes(c.connectionId)) ?? [],
      }));
    },
    [queryClient]
  );
};

const useConnectionList = (): ListConnection => {
  const workspace = useCurrentWorkspace();
  const service = useWebConnectionService();

  return useSuspenseQuery(connectionsKeys.lists(), () => service.list(workspace.workspaceId));
};

const useGetConnectionState = (connectionId: string) => {
  const service = useConnectionService();

  return useSuspenseQuery(connectionsKeys.getState(connectionId), () => service.getState(connectionId));
};

export {
  useConnectionList,
  useGetConnection,
  useUpdateConnection,
  useCreateConnection,
  useDeleteConnection,
  useGetConnectionState,
};
