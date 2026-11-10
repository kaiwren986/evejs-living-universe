"use strict";

const authority = require("./compressionAuthority.json");

// Same relation in the authoring tool and runtime. The client has no name or
// market-group fallback: an absent source ID is not compressible.
function buildCompressedTypeMaps(types = null, buildNumber = authority.source.clientBuild) {
  if (buildNumber !== authority.source.clientBuild) {
    throw new Error(`Compression authority is pinned to client build ${authority.source.clientBuild}, not ${buildNumber}`);
  }
  const admitted = types === null ? null : new Set(types.map((type) => type.typeID));
  const compressedTypeBySourceTypeID = {};
  const sourceTypesByCompressedTypeID = {};
  for (const [source, output] of Object.entries(authority.compressedTypeBySourceTypeID)) {
    const sourceID = Number(source);
    if (admitted && !admitted.has(sourceID)) continue;
    if (admitted && !admitted.has(output)) {
      throw new Error(`Compression output type ${output} for source ${sourceID} is missing from the target type catalog`);
    }
    compressedTypeBySourceTypeID[source] = output;
    (sourceTypesByCompressedTypeID[output] ||= []).push(sourceID);
  }
  return { compressedTypeBySourceTypeID, sourceTypesByCompressedTypeID };
}

module.exports = { buildCompressedTypeMaps, compressionSource: authority.source };
