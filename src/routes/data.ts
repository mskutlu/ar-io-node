/**
 * AR.IO Gateway
 * Copyright (C) 2022,2023 Permanent Data Solutions, Inc
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import { Request, Response } from 'express';
import { Logger } from 'winston';

import { MANIFEST_CONTENT_TYPE } from '../lib/encoding.js';
import {
  ContiguousData,
  ContiguousDataIndex,
  ContiguousDataSource,
  ManifestPathResolver,
} from '../types.js';

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

const setDataHeaders = ({
  res,
  data,
  contentType,
}: {
  res: Response;
  data: ContiguousData;
  contentType: string;
}) => {
  // TODO add cache header(s)
  // TODO add etag

  res.contentType(contentType);
  res.header('Content-Length', data.size.toString());
};

// Data routes
export const RAW_DATA_PATH_REGEX = /^\/raw\/([a-zA-Z0-9-_]{43})\/?$/i;
export const rawDataHandler = ({
  log,
  dataIndex,
  dataSource,
}: {
  log: Logger;
  dataSource: ContiguousDataSource;
  dataIndex: ContiguousDataIndex;
}) => {
  return async (req: Request, res: Response) => {
    const id = req.params[0];
    let data: ContiguousData | undefined;
    try {
      // Retrieve authoritative data attributes if they're available
      const dataAttributes = await dataIndex.getDataAttributes(id);
      let contentType: string | undefined;
      if (dataAttributes) {
        contentType = dataAttributes.contentType;
      }

      try {
        data = await dataSource.getData(id);
      } catch (error: any) {
        log.warn('Unable to retrieve contiguous data:', {
          dataId: id,
          message: error.message,
          stack: error.stack,
        });
        res.status(404).send('Not found');
        return;
      }

      contentType =
        contentType ?? data.sourceContentType ?? DEFAULT_CONTENT_TYPE;
      setDataHeaders({ res, data, contentType });
      data.stream.pipe(res);
    } catch (error: any) {
      log.error('Error retrieving raw data:', {
        dataId: id,
        message: error.message,
        stack: error.stack,
      });
      data?.stream.destroy();
      res.status(404).send('Not found');
    }
  };
};

const handleManifest = async ({
  log,
  res,
  dataSource,
  dataIndex,
  resolvedId,
  complete,
}: {
  log: Logger;
  res: Response;
  dataSource: ContiguousDataSource;
  dataIndex: ContiguousDataIndex;
  resolvedId: string | undefined;
  complete: boolean;
}): Promise<boolean> => {
  let data: ContiguousData | undefined;
  try {
    if (resolvedId !== undefined) {
      // Retrieve authoritative data attributes if available
      const dataAttributes = await dataIndex.getDataAttributes(resolvedId);
      let contentType: string | undefined;
      if (dataAttributes) {
        contentType = dataAttributes.contentType;
      }

      // Retrieve data based on ID resolved from manifest path or index
      try {
        data = await dataSource.getData(resolvedId);
      } catch (error: any) {
        log.warn('Unable to retrieve contiguous data:', {
          dataId: resolvedId,
          message: error.message,
          stack: error.stack,
        });
        // Indicate response was NOT sent
        return false;
      }

      // Set headers and stream response
      contentType =
        contentType ?? data.sourceContentType ?? DEFAULT_CONTENT_TYPE;
      setDataHeaders({ res, data, contentType });
      data.stream.pipe(res);

      // Indicate response was sent
      return true;
    }

    // Return 404 for not found index or path (arweave.net gateway behavior)
    if (complete) {
      res.status(404).send('Not found');

      // Indicate response was sent
      return true;
    }
  } catch (error: any) {
    log.error('Error retrieving manifest data:', {
      dataId: resolvedId,
      message: error.message,
      stack: error.stack,
    });
    data?.stream.destroy();
  }

  // Indicate response was NOT sent
  return false;
};

export const DATA_PATH_REGEX =
  /^\/?([a-zA-Z0-9-_]{43})\/?$|^\/?([a-zA-Z0-9-_]{43})\/(.*)$/i;
export const dataHandler = ({
  log,
  dataIndex,
  dataSource,
  manifestPathResolver,
}: {
  log: Logger;
  dataSource: ContiguousDataSource;
  dataIndex: ContiguousDataIndex;
  manifestPathResolver: ManifestPathResolver;
}) => {
  return async (req: Request, res: Response) => {
    const id = req.params[0] ?? req.params[1];
    const manifestPath = req.params[2];
    let data: ContiguousData | undefined;
    try {
      let contentType: string | undefined;
      const dataAttributes = await dataIndex.getDataAttributes(id);
      if (dataAttributes) {
        contentType = dataAttributes.contentType;
      }

      // Attempt manifest path resolution from the index (without data parsing)
      if (dataAttributes?.isManifest) {
        const manifestResolution = await manifestPathResolver.resolveFromIndex(
          id,
          manifestPath,
        );

        if (
          await handleManifest({
            log,
            res,
            dataIndex,
            dataSource,
            ...manifestResolution,
          })
        ) {
          return;
        }
      }

      try {
        data = await dataSource.getData(id);
      } catch (error: any) {
        log.warn('Unable to retrieve contiguous data:', {
          dataId: id,
          message: error.message,
          stack: error.stack,
        });
        res.status(404).send('Not found');
        return;
      }
      contentType = contentType ?? data.sourceContentType;

      // Fall back to on-demand manifest parsing
      if (contentType === MANIFEST_CONTENT_TYPE) {
        const manifestResolution = await manifestPathResolver.resolveFromData(
          data,
          id,
          manifestPath,
        );

        // The original stream is no longer needed after path resolution
        data.stream.destroy();

        if (
          !(await handleManifest({
            log,
            res,
            dataIndex,
            dataSource,
            ...manifestResolution,
          }))
        ) {
          // for readability (should be unreachable)
          res.status(404).send('Not found');
        }
        return;
      }

      contentType = contentType ?? DEFAULT_CONTENT_TYPE;
      setDataHeaders({ res, data, contentType });
      data.stream.pipe(res);
    } catch (error: any) {
      log.error('Error retrieving data:', {
        dataId: id,
        manifestPath,
        message: error.message,
        stack: error.stack,
      });
      res.status(404).send('Not found');
      data?.stream.destroy();
    }
  };
};