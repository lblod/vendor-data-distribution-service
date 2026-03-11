export const changesetsSubmission = [
  {
    inserts: [
      {
        subject: {
          value: 'http://data.lblod.info/submissions/65F98FB2049CAEA56A94ACD5',
          type: 'uri',
        },
        predicate: {
          value: 'http://mu.semte.ch/vocabularies/core/uuid',
          type: 'uri',
        },
        object: {
          value: '65F98FB2049CAEA56A94ACD5',
          type: 'literal',
        },
        graph: {
          value:
            'http://mu.semte.ch/graphs/organizations/28346950e285b8b816133fece5ac9408097c3f190c7f32573cf0c640d6c34b1a/LoketLB-databankEredienstenGebruiker',
          type: 'uri',
        },
      },
    ],
    deletes: [],
  },
];

export const changesetsFormData = [
  {
    inserts: [
      {
        subject: {
          value:
            'http://data.lblod.info/form-data/a96e79a0-e5f2-11ee-b0f6-134727f6f792',
          type: 'uri',
        },
        predicate: {
          value: 'dcterms:created',
          type: 'uri',
        },
        object: {
          value: '2024-03-19T13:14:26.941Z',
          type: 'literal',
          datatype: 'http://www.w3.org/2001/XMLSchema#dateTime',
        },
        graph: {
          value:
            'http://mu.semte.ch/graphs/organizations/28346950e285b8b816133fece5ac9408097c3f190c7f32573cf0c640d6c34b1a/LoketLB-databankEredienstenGebruiker',
          type: 'uri',
        },
      },
    ],
    deletes: [],
  },
];

export const changesetsPhysicalFile = [
  {
    inserts: [
      {
        subject: {
          value: 'share://submissions/a95c7841-e5f2-11ee-af61-1f38860d7b3b.ttl',
          type: 'uri',
        },
        predicate: {
          value: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
          type: 'uri',
        },
        object: {
          value:
            'http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#FileDataObject',
          type: 'uri',
        },
        graph: {
          value:
            'http://mu.semte.ch/graphs/organizations/28346950e285b8b816133fece5ac9408097c3f190c7f32573cf0c640d6c34b1a/LoketLB-databankEredienstenGebruiker',
          type: 'uri',
        },
      },
    ],
    deletes: [],
  },
];
